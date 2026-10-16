/**
 * Provider rate limiting (spec FR-8, decision "provider calls pass through a
 * limiter keyed llm:<provider>:<model>").
 *
 * Two guards, because a free-tier key has both:
 *
 * 1. **Per-minute** — the same sliding-window-log algorithm as the send path's
 *    `RateLimiter`, on purpose: same Lua script, same semantics, one window of
 *    `LLM_RATE_LIMIT_PER_MIN` calls per rolling 60 s, so there is no boundary
 *    spike. The send path's class is left completely untouched — this is a
 *    sibling with a different key and a configurable window.
 * 2. **Daily** — one counter per provider+model per day, reset at midnight in
 *    `LLM_DAILY_RESET_TZ`, soft-capped at `LLM_RATE_LIMIT_PER_DAY`. When the cap
 *    is reached the caller stops calling the provider and falls the remaining
 *    drafts back, rather than discovering the limit through 429s.
 *
 * A database is not involved: the counters live in Redis and are advisory. Losing
 * Redis loses the counters, which costs at most one day of over-calling.
 */

import Redis from "ioredis";

export type LlmLimitResult =
  | { status: "ok" }
  /** Per-minute limit: wait `retryAfterMs` and try again (retryable). */
  | { status: "rate_limited"; retryAfterMs: number }
  /** Daily cap reached: do not retry, fall back, and stop the campaign's fan-out. */
  | { status: "quota_exhausted"; day: string; used: number; limit: number };

export interface LlmLimiterOptions {
  /** Calls allowed per rolling minute, per provider+model. */
  perMinute: number;
  /** Requests allowed per calendar day in `resetTimeZone`; undefined = no cap. */
  dailyLimit?: number;
  /** IANA zone whose midnight rolls the daily counter. */
  resetTimeZone: string;
  /** Injectable clock, for tests. */
  now?: () => number;
}

const WINDOW_MS = 60_000;
/** Counters outlive the day they belong to, so a late call still sees them. */
const DAILY_TTL_SECONDS = 2 * 24 * 60 * 60;

export class LlmLimiter {
  private readonly redis: Redis;
  private readonly options: LlmLimiterOptions;

  constructor(redis: Redis, options: LlmLimiterOptions) {
    this.redis = redis;
    this.options = options;
  }

  /** Per-minute window key, exactly as specified: `llm:<provider>:<model>`. */
  minuteKey(provider: string, model: string): string {
    return `llm:${provider}:${model}`;
  }

  dailyKey(provider: string, model: string, day: string): string {
    return `llm:daily:${provider}:${model}:${day}`;
  }

  /** `YYYY-MM-DD` in the configured zone — the day boundary the counter uses. */
  currentDay(at = this.now()): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.options.resetTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(at));
  }

  /**
   * Take one slot for a provider call.
   *
   * The daily slot is only consumed when the minute limit lets the call through,
   * so a request that was never made cannot burn the daily budget.
   */
  async tryAcquire(provider: string, model: string): Promise<LlmLimitResult> {
    const allowed = await this.takeMinuteSlot(provider, model);
    if (!allowed) {
      return { status: "rate_limited", retryAfterMs: await this.msUntilMinuteSlot(provider, model) };
    }

    const { dailyLimit } = this.options;
    if (dailyLimit === undefined) return { status: "ok" };

    const day = this.currentDay();
    const key = this.dailyKey(provider, model, day);
    const used = await this.redis.incr(key);
    if (used === 1) {
      await this.redis.expire(key, DAILY_TTL_SECONDS);
    }

    if (used > dailyLimit) {
      // Soft cap: report the real usage but do not let the counter run away.
      await this.redis.decr(key);
      return { status: "quota_exhausted", day, used: dailyLimit, limit: dailyLimit };
    }

    return { status: "ok" };
  }

  /** Usage of today's counter, for metrics and the approval warning (Phase 5). */
  async dailyUsage(provider: string, model: string): Promise<number> {
    const value = await this.redis.get(this.dailyKey(provider, model, this.currentDay()));
    return value === null ? 0 : Number(value);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Sliding window log: drop entries older than the window, then admit the call
   * only while the remaining count is under the limit. One Lua script so trim +
   * count + add cannot interleave between workers.
   */
  private async takeMinuteSlot(provider: string, model: string): Promise<boolean> {
    const key = this.minuteKey(provider, model);
    const now = this.now();
    const windowStart = now - WINDOW_MS;
    const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;

    const result = (await this.redis.eval(
      `
        local key = KEYS[1]
        local windowStart = tonumber(ARGV[1])
        local now = ARGV[2]
        local member = ARGV[3]
        local maxPerWindow = tonumber(ARGV[4])

        redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
        local count = redis.call('ZCARD', key)

        if count < maxPerWindow then
          redis.call('ZADD', key, now, member)
          redis.call('PEXPIRE', key, ${WINDOW_MS + 60_000})
          return 1
        end

        return 0
      `,
      1,
      key,
      windowStart.toString(),
      now.toString(),
      member,
      this.options.perMinute.toString()
    )) as number;

    return result === 1;
  }

  /** Milliseconds until the oldest call in the window ages out. */
  private async msUntilMinuteSlot(provider: string, model: string): Promise<number> {
    const key = this.minuteKey(provider, model);
    const oldest = await this.redis.zrange(key, 0, 0, "WITHSCORES");

    if (oldest.length < 2) return 0;

    const oldestAt = Number(oldest[1]);
    if (!Number.isFinite(oldestAt)) return WINDOW_MS;

    return Math.max(0, oldestAt + WINDOW_MS - this.now());
  }
}
