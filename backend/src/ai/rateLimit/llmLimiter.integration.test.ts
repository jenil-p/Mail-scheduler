import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Redis from "ioredis";

/**
 * The two Redis limiters, against a real Redis.
 *
 * The second suite is the regression guard for the send path: `RateLimiter` was
 * left untouched when `LlmLimiter` was added, and its behaviour (N sends per
 * rolling hour, per sender) must still be exactly that.
 *
 * Gated on TEST_REDIS_*; run with `npm run test:integration`.
 */
const redisHost = process.env.TEST_REDIS_HOST;
const redisPort = process.env.TEST_REDIS_PORT;
const suite = redisHost && redisPort ? describe : describe.skip;

/** Kept small so the hourly window can be exhausted in a test. */
const SEND_LIMIT = 3;

suite("LLM and send limiters (integration)", () => {
  let redis: Redis;
  let LlmLimiter: typeof import("./llmLimiter").LlmLimiter;
  let RateLimiter: typeof import("../../queue/rateLimiter").RateLimiter;

  beforeAll(async () => {
    process.env.REDIS_HOST = redisHost;
    process.env.REDIS_PORT = redisPort;
    // Must be set before the config module loads, because the send limiter reads
    // it once at construction.
    process.env.MAX_EMAILS_PER_HOUR = String(SEND_LIMIT);

    const [redisModule, limiterModule, rateLimiterModule] = await Promise.all([
      import("ioredis"),
      import("./llmLimiter"),
      import("../../queue/rateLimiter"),
    ]);

    const RedisCtor = (redisModule as unknown as { default: new (o: object) => Redis }).default;
    redis = new RedisCtor({ host: redisHost, port: Number(redisPort), maxRetriesPerRequest: null });

    LlmLimiter = limiterModule.LlmLimiter;
    RateLimiter = rateLimiterModule.RateLimiter;
  });

  afterAll(async () => {
    const keys = await redis.keys("llm:*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  async function clearLlmKeys(): Promise<void> {
    const keys = await redis.keys("llm:*");
    if (keys.length > 0) await redis.del(...keys);
  }

  describe("LlmLimiter per-minute window", () => {
    it("admits exactly the configured number of calls per rolling minute", async () => {
      await clearLlmKeys();

      const limiter = new LlmLimiter(redis, {
        perMinute: 3,
        resetTimeZone: "UTC",
      });

      const results = [];
      for (let i = 0; i < 4; i++) {
        results.push((await limiter.tryAcquire("mock", "mock-model")).status);
      }

      expect(results).toEqual(["ok", "ok", "ok", "rate_limited"]);

      // Keyed by provider and model, as specified.
      expect(limiter.minuteKey("mock", "mock-model")).toBe("llm:mock:mock-model");
      expect(await redis.exists("llm:mock:mock-model")).toBe(1);
    });

    it("reports how long to wait, inside the minute window", async () => {
      await clearLlmKeys();

      const limiter = new LlmLimiter(redis, { perMinute: 1, resetTimeZone: "UTC" });

      expect((await limiter.tryAcquire("mock", "mock-model")).status).toBe("ok");

      const blocked = await limiter.tryAcquire("mock", "mock-model");
      expect(blocked.status).toBe("rate_limited");

      if (blocked.status === "rate_limited") {
        expect(blocked.retryAfterMs).toBeGreaterThan(0);
        expect(blocked.retryAfterMs).toBeLessThanOrEqual(60_000);
      }
    });

    it("gives each model its own window", async () => {
      await clearLlmKeys();

      const limiter = new LlmLimiter(redis, { perMinute: 1, resetTimeZone: "UTC" });

      expect((await limiter.tryAcquire("mock", "model-a")).status).toBe("ok");
      expect((await limiter.tryAcquire("mock", "model-a")).status).toBe("rate_limited");
      expect((await limiter.tryAcquire("mock", "model-b")).status).toBe("ok");
    });
  });

  describe("LlmLimiter daily counter", () => {
    it("caps the day, reports the cap, and does not run past it", async () => {
      await clearLlmKeys();

      const limiter = new LlmLimiter(redis, {
        perMinute: 1_000,
        dailyLimit: 2,
        resetTimeZone: "UTC",
      });

      expect((await limiter.tryAcquire("mock", "mock-model")).status).toBe("ok");
      expect((await limiter.tryAcquire("mock", "mock-model")).status).toBe("ok");

      const third = await limiter.tryAcquire("mock", "mock-model");
      expect(third.status).toBe("quota_exhausted");

      if (third.status === "quota_exhausted") {
        expect(third.limit).toBe(2);
        expect(third.used).toBe(2);
        expect(third.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }

      // The refused call is not counted, so the counter still reads the cap.
      expect(await limiter.dailyUsage("mock", "mock-model")).toBe(2);
      expect((await limiter.tryAcquire("mock", "mock-model")).status).toBe("quota_exhausted");
    });

    it("keeps a counter per model per day", async () => {
      await clearLlmKeys();

      const limiter = new LlmLimiter(redis, {
        perMinute: 1_000,
        dailyLimit: 1,
        resetTimeZone: "UTC",
      });

      expect((await limiter.tryAcquire("mock", "model-a")).status).toBe("ok");
      expect((await limiter.tryAcquire("mock", "model-a")).status).toBe("quota_exhausted");
      expect((await limiter.tryAcquire("gemini", "model-a")).status).toBe("ok");
      expect((await limiter.tryAcquire("mock", "model-b")).status).toBe("ok");
    });

    it("rolls the counter at midnight in the configured zone", async () => {
      await clearLlmKeys();

      // 2026-10-17 23:30 in Los Angeles is already 2026-10-18 in UTC.
      const beforeMidnight = Date.UTC(2026, 9, 18, 6, 30);
      const afterMidnight = Date.UTC(2026, 9, 18, 7, 30);

      const laLimiter = new LlmLimiter(redis, {
        perMinute: 1_000,
        dailyLimit: 1,
        resetTimeZone: "America/Los_Angeles",
        now: () => beforeMidnight,
      });

      expect(laLimiter.currentDay()).toBe("2026-10-17");
      expect((await laLimiter.tryAcquire("mock", "day-model")).status).toBe("ok");
      expect((await laLimiter.tryAcquire("mock", "day-model")).status).toBe("quota_exhausted");

      const utcLimiter = new LlmLimiter(redis, {
        perMinute: 1_000,
        dailyLimit: 1,
        resetTimeZone: "UTC",
        now: () => beforeMidnight,
      });

      expect(utcLimiter.currentDay()).toBe("2026-10-18");
      // The same instant is a different day in UTC, so it gets its own counter.
      expect((await utcLimiter.tryAcquire("mock", "day-model-utc")).status).toBe("ok");
      expect((await utcLimiter.tryAcquire("mock", "day-model-utc")).status).toBe("quota_exhausted");

      const nextDay = new LlmLimiter(redis, {
        perMinute: 1_000,
        dailyLimit: 1,
        resetTimeZone: "America/Los_Angeles",
        now: () => afterMidnight,
      });

      expect(nextDay.currentDay()).toBe("2026-10-18");
      expect((await nextDay.tryAcquire("mock", "day-model")).status).toBe("ok");
    });

    it("imposes no daily limit when none is configured", async () => {
      await clearLlmKeys();

      const limiter = new LlmLimiter(redis, { perMinute: 1_000, resetTimeZone: "UTC" });

      for (let i = 0; i < 20; i++) {
        expect((await limiter.tryAcquire("mock", "mock-model")).status).toBe("ok");
      }

      expect(await limiter.dailyUsage("mock", "mock-model")).toBe(0);
    });
  });

  describe("the send path's RateLimiter is unchanged", () => {
    it("allows the hourly allowance per sender and refuses the next one", async () => {
      const sender = `integration-${Date.now()}@example.com`;
      await redis.del(`rate_limit:${sender}:log`);

      const limiter = new RateLimiter(redis);

      for (let i = 0; i < SEND_LIMIT; i++) {
        expect(await limiter.tryIncrement(sender)).toBe(true);
      }

      expect(await limiter.tryIncrement(sender)).toBe(false);

      // Still the same key shape as before the LLM work.
      expect(await redis.exists(`rate_limit:${sender}:log`)).toBe(1);
    });

    it("keeps senders independent and reports the wait to the end of the window", async () => {
      const sender = `integration-${Date.now()}-a@example.com`;
      const other = `integration-${Date.now()}-b@example.com`;
      await redis.del(`rate_limit:${sender}:log`, `rate_limit:${other}:log`);

      const limiter = new RateLimiter(redis);

      expect(await limiter.tryIncrement(sender)).toBe(true);
      for (let i = 1; i < SEND_LIMIT; i++) await limiter.tryIncrement(sender);
      expect(await limiter.tryIncrement(sender)).toBe(false);

      // A different sender has its own window, and an un-limited sender waits 0.
      expect(await limiter.tryIncrement(other)).toBe(true);
      expect(await limiter.getMsUntilNextWindow(other)).toBeGreaterThan(0);

      expect(await limiter.getMsUntilNextWindow(sender)).toBeLessThanOrEqual(3_600_000);
      expect(await limiter.getMsUntilNextWindow(sender)).toBeGreaterThan(0);

      await redis.del(`rate_limit:${sender}:log`, `rate_limit:${other}:log`);
    });
  });
});
