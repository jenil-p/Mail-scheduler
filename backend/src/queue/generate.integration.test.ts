import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Queue, Worker } from "bullmq";
import type Redis from "ioredis";
import type { PrismaClient } from "../generated/prisma/client";
import type { AiConfig } from "../config/ai";
import type { CampaignStatus } from "../generated/prisma/enums";
import { parseAiConfig } from "../config/ai";
import { MockLlmClient } from "../ai/llm/mock";
import { RetryableError } from "../ai/llm/LlmClient";
import { promptFingerprint } from "../ai/identity";
import { PROMPT_VERSION } from "../ai/prompts/personalize.v1";
import type { LlmLimiter } from "../ai/rateLimit/llmLimiter";
import type { GenerateDeps, GenerateResult } from "./generateWorker";
import type { GenerateJobData } from "./generateJob";

/**
 * End-to-end generation against a real Postgres and a real Redis, with the
 * scripted **mock** provider — no network, no cost, no flakiness (NFR-7).
 *
 * Gated on TEST_DATABASE_URL + TEST_REDIS_*; run with `npm run test:integration`.
 * Point both at throwaway instances: the suite writes rows, deletes the campaigns
 * it creates, and clears the queue and limit keys it uses. All data here is fake
 * (see the free-tier data-handling note in docs/phase-notes.md).
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testRedisHost = process.env.TEST_REDIS_HOST;
const testRedisPort = process.env.TEST_REDIS_PORT;

const suite = testDatabaseUrl && testRedisHost && testRedisPort ? describe : describe.skip;

/** The queue's attempts are `1 + MAX_RETRIES`, so three provider calls at most. */
const MAX_RETRIES = 2;

suite("generate worker (integration)", () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let redisConnection: Redis;
  let queue: Queue<GenerateJobData>;
  let createGenerateWorker: typeof import("./generateWorker").createGenerateWorker;
  let processGenerate: typeof import("./generateWorker").processGenerate;
  let enqueueGenerate: typeof import("../campaigns/enqueue").enqueueGenerate;
  let LlmLimiterClass: typeof import("../ai/rateLimit/llmLimiter").LlmLimiter;

  const campaignIds: string[] = [];
  const workers: Worker[] = [];

  /** The config every test shares; `mock` needs neither a key nor a model id. */
  function aiConfig(overrides: Record<string, string> = {}): AiConfig {
    return parseAiConfig({
      AI_PERSONALIZATION_ENABLED: "true",
      LLM_PROVIDER: "mock",
      LLM_RATE_LIMIT_PER_MIN: "1000",
      LLM_RATE_LIMIT_PER_DAY: "1000",
      LLM_DAILY_RESET_TZ: "UTC",
      LLM_MAX_RETRIES: String(MAX_RETRIES),
      LLM_MAX_PARSE_RETRIES: "2",
      LLM_RETRY_BASE_MS: "20",
      LLM_RETRY_MAX_MS: "80",
      LLM_TIMEOUT_MS: "1000",
      GENERATE_CONCURRENCY: "1",
      ...overrides,
    });
  }

  beforeAll(async () => {
    // These modules read the environment when they load, so the throwaway
    // instances have to be in place before they are imported.
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.REDIS_HOST = testRedisHost;
    process.env.REDIS_PORT = testRedisPort;

    const [
      { prisma: client },
      workerModule,
      enqueueModule,
      queueModule,
      connectionModule,
      limiterModule,
      RedisModule,
    ] = await Promise.all([
      import("../db/pool"),
      import("./generateWorker"),
      import("../campaigns/enqueue"),
      import("./generateQueue"),
      import("./queue"),
      import("../ai/rateLimit/llmLimiter"),
      import("ioredis"),
    ]);

    prisma = client;
    createGenerateWorker = workerModule.createGenerateWorker;
    processGenerate = workerModule.processGenerate;
    enqueueGenerate = enqueueModule.enqueueGenerate;
    redisConnection = connectionModule.redisConnection;
    LlmLimiterClass = limiterModule.LlmLimiter;

    const RedisCtor = (RedisModule as unknown as { default: new (o: object) => Redis }).default;
    redis = new RedisCtor({
      host: testRedisHost,
      port: Number(testRedisPort),
      maxRetriesPerRequest: null,
    });

    queue = queueModule.getGenerateQueue();
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    for (const worker of workers) await worker.close().catch(() => undefined);
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    await redis?.quit();
    await redisConnection?.quit();

    if (campaignIds.length > 0) {
      await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    }
    await prisma.$disconnect();
  });

  afterEach(async () => {
    // Close this test's workers before the next one starts. BullMQ hands a job to
    // any live worker of the queue, so a leftover worker would process the next
    // test's jobs with the previous test's scripted provider.
    while (workers.length > 0) {
      const worker = workers.pop();
      await worker?.close().catch(() => undefined);
    }

    // The queue-wide limiter key and the provider counters are shared state in
    // Redis; without clearing them a rate-limited test would stall the next one.
    await redis.del("bull:generate:limiter");
    const keys = await redis.keys("llm:*");
    if (keys.length > 0) await redis.del(...keys);
  });

  /** A campaign with the frozen prompt identity the worker expects. */
  async function createCampaign(options: {
    recipients: Array<{
      email?: string;
      firstName?: string | null;
      company?: string | null;
      role?: string | null;
      note?: string | null;
    }>;
    promptTemplateVersion?: string;
    aiInstruction?: string;
    model?: string;
    status?: CampaignStatus;
  }): Promise<string> {
    const promptTemplateVersion = options.promptTemplateVersion ?? PROMPT_VERSION;
    const aiInstruction = options.aiInstruction ?? "Warm and specific.";
    const model = options.model ?? "mock-model";

    const campaign = await prisma.campaign.create({
      data: {
        userId: "integration-test@example.com",
        name: "Generate integration campaign",
        subjectTemplate: "Workshop invitation",
        bodyTemplate:
          "Hi {{first_name}},\n\n{{ai_intro}}\n\nWe are running a workshop on support automation.\n\n{{unsubscribe_link}}",
        templateHash: `hash-${randomUUID()}`,
        linkUrl: "https://example.com/workshop",
        unsubscribeUrl: "https://example.com/unsubscribe",
        aiEnabled: true,
        aiInstruction,
        promptFingerprint: promptFingerprint({
          promptTemplateVersion,
          aiInstruction,
          llmModel: model,
        }),
        llmModel: model,
        promptTemplateVersion,
        scheduledAt: new Date(Date.now() + 3_600_000),
        status: options.status ?? "GENERATING",
      },
    });

    campaignIds.push(campaign.id);

    await prisma.recipient.createMany({
      data: options.recipients.map((recipient, index) => {
        const fields = {
          company: recipient.company === undefined ? "Acme Corp" : recipient.company,
          role: recipient.role === undefined ? "Head of Ops" : recipient.role,
          note: recipient.note === undefined ? "met at a conference" : recipient.note,
        };

        return {
          campaignId: campaign.id,
          email: recipient.email ?? `recipient-${index}-${randomUUID()}@example.com`,
          firstName: recipient.firstName === undefined ? `Person${index}` : recipient.firstName,
          company: fields.company,
          role: fields.role,
          note: fields.note,
          hasPersonalizationData: [fields.company, fields.role, fields.note].some(
            (value) => typeof value === "string" && value.trim() !== ""
          ),
        };
      }),
    });

    return campaign.id;
  }

  async function recipientsOf(campaignId: string) {
    return prisma.recipient.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } });
  }

  function mkLimiter(ai: AiConfig): LlmLimiter {
    return new LlmLimiterClass(redis, {
      perMinute: ai.rateLimitPerMin,
      dailyLimit: ai.dailyRateLimit,
      resetTimeZone: ai.dailyResetTz,
    });
  }

  function processedDeps(llm: MockLlmClient, ai: AiConfig): GenerateDeps {
    return {
      prisma,
      llm,
      limiter: mkLimiter(ai),
      ai,
      rateLimit: async () => undefined,
      log: () => undefined,
    };
  }

  function startWorker(llm: MockLlmClient, ai: AiConfig) {
    const worker = createGenerateWorker({
      prisma,
      llm,
      ai,
      limiter: mkLimiter(ai),
      redis,
      rateLimit: (ms) => queue.rateLimit(ms),
      log: () => undefined,
    });

    workers.push(worker);
    return worker;
  }

  /** Poll until `check` is truthy, or fail with a readable label. */
  async function waitFor<T>(
    check: () => Promise<T | undefined | null | false>,
    label: string,
    timeoutMs = 20_000
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function draftOf(campaignId: string, recipientId: string) {
    return prisma.generatedDraft.findFirst({ where: { campaignId, recipientId } });
  }

  /**
   * Enqueue with this suite's config. The attempt budget the worker reads comes
   * from the job, so the enqueuer has to be given the same config the worker runs
   * with — otherwise the job would carry the process default and never look like a
   * "last attempt".
   */
  function enqueue(campaignId: string, recipientId: string, ai: AiConfig, isSample = false) {
    return enqueueGenerate(campaignId, recipientId, { isSample }, { db: prisma, ai });
  }

  /** Resolves when the worker finishes the given draft's job. */
  function jobFinished(worker: Worker, draftId: string): Promise<void> {
    return new Promise((resolve) => {
      worker.on("completed", (job) => {
        if ((job.data as GenerateJobData).draftId === draftId) resolve();
      });
    });
  }

  it("runs the same job twice with exactly one provider call and one draft", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({ recipients: [{}] });
    const [recipient] = await recipientsOf(campaignId);

    const first = await enqueue(campaignId, recipient.id, ai);
    const second = await enqueue(campaignId, recipient.id, ai);

    // The same campaign + recipient + template + prompt is always the same draft.
    expect(second.draftId).toBe(first.draftId);

    const llm = new MockLlmClient();
    startWorker(llm, ai);

    const ready = await waitFor(async () => {
      const draft = await draftOf(campaignId, recipient.id);
      return draft?.status === "READY" ? draft : undefined;
    }, "the draft to be READY");

    expect(llm.callCount).toBe(1);
    expect(ready.aiIntro).toBe("Mock intro for call 1");
    expect(ready.attempts).toBe(1);

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    expect(ready.promptVersion).toBe(campaign?.promptFingerprint);

    // The job is delivered again — a restart, a redelivery — and costs nothing.
    const again = await processGenerate(processedDeps(llm, ai), {
      data: { draftId: first.draftId, campaignId, recipientId: recipient.id, isSample: false },
      attemptsMade: 0,
      opts: { attempts: 1 + MAX_RETRIES },
    });

    expect(again.outcome).toBe("SKIPPED_TERMINAL");
    expect(llm.callCount).toBe(1);
    expect(await prisma.generatedDraft.count({ where: { campaignId } })).toBe(1);
  });

  it("honours a per-minute 429 retry delay and then succeeds", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({ recipients: [{}] });
    const [recipient] = await recipientsOf(campaignId);

    await enqueue(campaignId, recipient.id, ai);

    const llm = new MockLlmClient({
      script: [
        { kind: "rate_limited", retryAfterMs: 150 },
        { kind: "success", intro: "Second try" },
      ],
    });

    startWorker(llm, ai);

    const ready = await waitFor(async () => {
      const draft = await draftOf(campaignId, recipient.id);
      return draft?.status === "READY" ? draft : undefined;
    }, "the draft to be READY after the 429");

    expect(llm.callCount).toBe(2);
    expect(ready.aiIntro).toBe("Second try");
    // Recorded as a metric, and it did not consume a retry (the job went back to
    // wait rather than failing), so the attempt count is the two provider calls.
    expect(ready.rateLimitHits).toBe(1);
    expect(ready.attempts).toBe(2);
  });

  it("falls back to the plain template after the retries are exhausted", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({ recipients: [{}] });
    const [recipient] = await recipientsOf(campaignId);

    await enqueue(campaignId, recipient.id, ai);

    const llm = new MockLlmClient({ script: [{ kind: "server_error" }] });
    startWorker(llm, ai);

    const fallen = await waitFor(async () => {
      const draft = await draftOf(campaignId, recipient.id);
      return draft?.status === "FALLBACK" ? draft : undefined;
    }, "the draft to fall back");

    expect(llm.callCount).toBe(1 + MAX_RETRIES); // the first attempt plus every retry
    expect(fallen.fallbackReason).toBe("SERVER_ERROR");
    expect(fallen.aiIntro).toBeNull();
    expect(fallen.body).not.toContain("{{ai_intro}}");
    expect(fallen.body).toContain("We are running a workshop on support automation.");
    expect(fallen.body).toContain('<a href="https://example.com/unsubscribe">');
    expect(fallen.subject).toBe("Workshop invitation");
  });

  it("recovers from two malformed responses and stores the valid one", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({ recipients: [{}] });
    const [recipient] = await recipientsOf(campaignId);

    await enqueue(campaignId, recipient.id, ai);

    const llm = new MockLlmClient({
      script: [
        { kind: "malformed_json" },
        { kind: "malformed_json" },
        { kind: "success", intro: "Third time is the charm" },
      ],
    });

    startWorker(llm, ai);

    const ready = await waitFor(async () => {
      const draft = await draftOf(campaignId, recipient.id);
      return draft?.status === "READY" ? draft : undefined;
    }, "the draft to be READY after two parse failures");

    expect(llm.callCount).toBe(3);
    expect(ready.aiIntro).toBe("Third time is the charm");
  });

  it("gives up after the parse-retry budget, with the parse failure stored", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({ recipients: [{}] });
    const [recipient] = await recipientsOf(campaignId);

    await enqueue(campaignId, recipient.id, ai);

    const llm = new MockLlmClient({ script: [{ kind: "malformed_json" }] });
    startWorker(llm, ai);

    const fallen = await waitFor(async () => {
      const draft = await draftOf(campaignId, recipient.id);
      return draft?.status === "FALLBACK" ? draft : undefined;
    }, "the draft to fall back on unparseable output");

    expect(llm.callCount).toBe(1 + ai.maxParseRetries);
    expect(fallen.fallbackReason).toBe("MALFORMED_JSON");
  });

  it("never calls the provider for a recipient with no personalization data", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({
      recipients: [{ company: "", role: null, note: null }],
    });
    const [recipient] = await recipientsOf(campaignId);

    expect(recipient.hasPersonalizationData).toBe(false);

    await enqueue(campaignId, recipient.id, ai);

    const llm = new MockLlmClient();
    startWorker(llm, ai);

    const fallen = await waitFor(async () => {
      const draft = await draftOf(campaignId, recipient.id);
      return draft?.status === "FALLBACK" ? draft : undefined;
    }, "the thin-data draft to fall back");

    expect(llm.callCount).toBe(0);
    expect(fallen.fallbackReason).toBe("THIN_DATA");
    expect(fallen.aiIntro).toBeNull();
    // The slot line is removed, not left behind as a blank line.
    expect(fallen.body).not.toContain("{{ai_intro}}");
    expect(fallen.body.startsWith("Hi Person0,")).toBe(true);
  });

  it("falls the campaign back and short-circuits the rest when the daily quota is gone", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({ recipients: [{}, {}, {}] });
    const recipients = await recipientsOf(campaignId);

    for (const recipient of recipients) {
      await enqueue(campaignId, recipient.id, ai);
    }

    const llm = new MockLlmClient({ script: [{ kind: "daily_quota" }] });
    startWorker(llm, ai);

    const drafts = await waitFor(async () => {
      const rows = await prisma.generatedDraft.findMany({ where: { campaignId } });
      return rows.length === 3 && rows.every((row) => row.status === "FALLBACK") ? rows : undefined;
    }, "every draft to fall back");

    // Exactly one call: the rest were short-circuited without touching the API.
    expect(llm.callCount).toBe(1);
    expect(drafts.every((draft) => draft.fallbackReason === "QUOTA_EXHAUSTED")).toBe(true);

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    expect(campaign?.status).toBe("GENERATING"); // a visible notice, not a pause
    expect(campaign?.errorMessage).toContain("daily AI quota");
    expect(campaign?.errorMessage).toContain("3 draft(s)");
  });

  it("stops at the local daily cap without calling the provider for the rest", async () => {
    const ai = aiConfig({ LLM_RATE_LIMIT_PER_DAY: "1" });
    const campaignId = await createCampaign({ recipients: [{}, {}] });
    const [first, second] = await recipientsOf(campaignId);

    await enqueue(campaignId, first.id, ai);
    await enqueue(campaignId, second.id, ai);

    const llm = new MockLlmClient();
    startWorker(llm, ai);

    const settled = await waitFor(async () => {
      const rows = await Promise.all([
        draftOf(campaignId, first.id),
        draftOf(campaignId, second.id),
      ]);
      return rows.every((row) => row && ["READY", "FALLBACK"].includes(row.status)) ? rows : undefined;
    }, "both drafts to settle against the local daily cap");

    expect(llm.callCount).toBe(1);
    expect(settled[0]?.status).toBe("READY");
    expect(settled[1]?.status).toBe("FALLBACK");
    expect(settled[1]?.fallbackReason).toBe("QUOTA_EXHAUSTED");
  });

  it("makes one provider call when two workers race for the same draft", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({ recipients: [{}] });
    const [recipient] = await recipientsOf(campaignId);

    const { draftId } = await enqueue(campaignId, recipient.id, ai);

    // 150ms of provider latency widens the window so both processors really start.
    const llm = new MockLlmClient({ latencyMs: 150 });

    const job = {
      data: { draftId, campaignId, recipientId: recipient.id, isSample: false },
      attemptsMade: 0,
      opts: { attempts: 1 + MAX_RETRIES },
    };

  const settled = await Promise.allSettled([
    processGenerate(processedDeps(llm, ai), job),
    processGenerate(processedDeps(llm, ai), job),
  ]);

  const fulfilled = settled
    .filter((r): r is PromiseFulfilledResult<GenerateResult> => r.status === "fulfilled")
    .map((r) => r.value.outcome);
  const rejected = settled.filter((r) => r.status === "rejected");

  // Exactly one worker generates; the other either loses the claim while the winner
  // is still generating (and throws a retryable) or arrives after the draft settled.
  expect(llm.callCount).toBe(1);
  expect(fulfilled.filter((o) => o === "READY")).toHaveLength(1);
  expect(fulfilled.length + rejected.length).toBe(2);

  if (rejected.length > 0) {
    // The loser threw because the draft was GENERATING and not stale (another worker
    // had claimed it) — the expected outcome when both processors start concurrently.
    expect(rejected[0].reason).toBeInstanceOf(RetryableError);
  } else {
    // The loser returned SKIPPED_NOT_CLAIMED (the draft was already terminal when it
    // tried to claim) — only one provider call was still made.
    expect(fulfilled).toContain("SKIPPED_NOT_CLAIMED");
  }

  expect(await prisma.generatedDraft.count({ where: { campaignId } })).toBe(1);

  const draft = await draftOf(campaignId, recipient.id);
  expect(draft?.status).toBe("READY");
  });

  it("does not generate when the campaign was frozen with another prompt version", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({
      recipients: [{}],
      promptTemplateVersion: "personalize.v0",
    });
    const [recipient] = await recipientsOf(campaignId);

    await enqueue(campaignId, recipient.id, ai);

    const llm = new MockLlmClient();
    startWorker(llm, ai);

    const campaign = await waitFor(async () => {
      const row = await prisma.campaign.findUnique({ where: { id: campaignId } });
      return row?.status === "PAUSED" ? row : undefined;
    }, "the campaign to pause");

    expect(llm.callCount).toBe(0);
    expect(campaign.errorMessage).toContain("personalize.v0");
    expect(campaign.errorMessage).toContain(PROMPT_VERSION);

    const draft = await draftOf(campaignId, recipient.id);
    expect(draft?.status).toBe("PENDING"); // never claimed
  });

  it("pauses the campaign when the stored model differs from this build's client", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({
      recipients: [{}],
      model: "other-model",
    });
    const [recipient] = await recipientsOf(campaignId);

    await enqueue(campaignId, recipient.id, ai);

    const llm = new MockLlmClient();
    startWorker(llm, ai);

    const campaign = await waitFor(async () => {
      const row = await prisma.campaign.findUnique({ where: { id: campaignId } });
      return row?.status === "PAUSED" ? row : undefined;
    }, "the campaign to pause on model mismatch");

    expect(llm.callCount).toBe(0);
    expect(campaign.errorMessage).toContain("other-model");
    expect(campaign.errorMessage).toContain("mock-model");

    const draft = await draftOf(campaignId, recipient.id);
    expect(draft?.status).toBe("PENDING"); // never claimed
  });

  it("skips a draft whose promptVersion does not match the campaign fingerprint", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({ recipients: [{}] });
    const [recipient] = await recipientsOf(campaignId);

    // Insert a draft under a stale fingerprint directly, as if it were created
    // before a regenerate and never re-enqueued under the new fingerprint.
    const staleDraftId = randomUUID();
    await prisma.generatedDraft.create({
      data: {
        id: staleDraftId,
        campaignId,
        recipientId: recipient.id,
        status: "PENDING",
        promptVersion: "stale-fingerprint-not-matching",
        subject: "",
        body: "",
        isSample: false,
      },
    });

    const llm = new MockLlmClient();
    startWorker(llm, ai);

    const result = await processGenerate(processedDeps(llm, ai), {
      data: { draftId: staleDraftId, campaignId, recipientId: recipient.id, isSample: false },
      attemptsMade: 0,
      opts: { attempts: 1 + MAX_RETRIES },
    });

    expect(result.outcome).toBe("SKIPPED_STALE");
    expect(llm.callCount).toBe(0);

    const draft = await prisma.generatedDraft.findUnique({ where: { id: staleDraftId } });
    expect(draft?.status).toBe("PENDING"); // skipped, not claimed, not fallen back
  });

  it("pauses the campaign on a rejected API key and leaves the draft PENDING", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({ recipients: [{}] });
    const [recipient] = await recipientsOf(campaignId);

    await enqueue(campaignId, recipient.id, ai);

    const llm = new MockLlmClient({ script: [{ kind: "auth", status: 401 }] });
    startWorker(llm, ai);

    const campaign = await waitFor(async () => {
      const row = await prisma.campaign.findUnique({ where: { id: campaignId } });
      return row?.status === "PAUSED" ? row : undefined;
    }, "the campaign to pause on the auth failure");

    const draft = await draftOf(campaignId, recipient.id);
    expect(draft?.status).toBe("PENDING");
    expect(draft?.fallbackReason).toBeNull();
    expect(llm.callCount).toBe(1); // no retries for a 401
    expect(campaign.errorMessage).toContain("API key");
  });

  it("skips a cancelled campaign instead of generating", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({ recipients: [{}] });
    const [recipient] = await recipientsOf(campaignId);

    const { draftId } = await enqueue(campaignId, recipient.id, ai);
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "CANCELLED" } });

    const llm = new MockLlmClient();
    const worker = startWorker(llm, ai);
    await jobFinished(worker, draftId);

    expect(llm.callCount).toBe(0);

    const draft = await draftOf(campaignId, recipient.id);
    expect(draft?.status).toBe("PENDING");
    expect(draft?.aiIntro).toBeNull();
  });

  it("does not regenerate finished drafts and reclaims a draft left stuck by a crash", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({ recipients: [{}, {}, {}] });
    const [first, second, third] = await recipientsOf(campaignId);

    // ── Batch 1: two drafts complete, the third is never started ──────────────
    const firstDraftId = (
      await enqueue(campaignId, first.id, ai)
    ).draftId;
    const secondDraftId = (
      await enqueue(campaignId, second.id, ai)
    ).draftId;

    const llmOne = new MockLlmClient({
      script: [
        { kind: "success", intro: "First draft" },
        { kind: "success", intro: "Second draft" },
      ],
    });

    const workerOne = startWorker(llmOne, ai);

    await waitFor(async () => {
      const rows = await prisma.generatedDraft.findMany({ where: { campaignId } });
      return rows.length === 2 && rows.every((row) => row.status === "READY");
    }, "the first batch to finish");

    await workerOne.close();

    const finished = await prisma.generatedDraft.findMany({ where: { campaignId } });
    const before = new Map(
      finished.map((row) => [row.id, { subject: row.subject, intro: row.aiIntro }])
    );
    expect(llmOne.callCount).toBe(2);
    expect(before.size).toBe(2);

    // ── The crash ────────────────────────────────────────────────────────────
    // A worker killed mid-call leaves exactly this behind: the claim written
    // (GENERATING), no completion, and a stale `updatedAt`. Aging the row stands in
    // for the crash having happened more than 2 x LLM_TIMEOUT_MS ago.
    const thirdDraftId = (
      await enqueue(campaignId, third.id, ai)
    ).draftId;

    await prisma.generatedDraft.update({
      where: { id: thirdDraftId },
      data: { status: "GENERATING", attempts: 1, updatedAt: new Date(Date.now() - 10_000) },
    });

    // ── The restart ──────────────────────────────────────────────────────────
    // The finished drafts' jobs are re-added too, exactly as a redelivery after a
    // restart would: they must cost nothing.
    const llmTwo = new MockLlmClient({ script: [{ kind: "success", intro: "Recovered draft" }] });
    startWorker(llmTwo, ai);

    await enqueue(campaignId, first.id, ai);
    await enqueue(campaignId, second.id, ai);

    const recovered = await waitFor(async () => {
      const rows = await prisma.generatedDraft.findMany({ where: { campaignId } });
      return rows.length === 3 && rows.every((row) => row.status === "READY") ? rows : undefined;
    }, "the stuck draft to be reclaimed and the finished ones to stay put");

    // One call, for the stuck draft only.
    expect(llmTwo.callCount).toBe(1);

    for (const row of recovered) {
      const previous = before.get(row.id);

      if (!previous) {
        expect(row.aiIntro).toBe("Recovered draft");
        expect(row.attempts).toBe(2); // the crashed claim, then the reclaim
        continue;
      }

      expect(row.subject).toBe(previous.subject);
      expect(row.aiIntro).toBe(previous.intro);
    }

    // The ids the worker had already finished are the ones it left alone.
    expect(before.has(firstDraftId)).toBe(true);
    expect(before.has(secondDraftId)).toBe(true);
  });

  it("ends in a bounded number of iterations with a terminal result under a saturated local limiter", async () => {
    const ai = aiConfig({
      LLM_RATE_LIMIT_PER_MIN: "1",
      LLM_MAX_RETRIES: "2",
      LLM_RETRY_BASE_MS: "250",
      LLM_RETRY_MAX_MS: "500",
    });
    const campaignId = await createCampaign({ recipients: [{}] });
    const [recipient] = await recipientsOf(campaignId);

    await enqueue(campaignId, recipient.id, ai);

    // Saturated limiter returning rate_limited with a small delay
    const saturatedLimiter = {
      tryAcquire: async () => ({ status: "rate_limited" as const, retryAfterMs: 250 }),
    } as unknown as LlmLimiter;

    const llm = new MockLlmClient();
    const worker = createGenerateWorker({
      prisma,
      llm,
      ai,
      limiter: saturatedLimiter,
      redis,
      rateLimit: (ms) => queue.rateLimit(ms),
      log: () => undefined,
    });
    workers.push(worker);

    const fallen = await waitFor(async () => {
      const draft = await draftOf(campaignId, recipient.id);
      return draft?.status === "FALLBACK" ? draft : undefined;
    }, "the draft to settle in FALLBACK under saturated limiter");

    expect(llm.callCount).toBe(0);
    expect(fallen.fallbackReason).toBe("RATE_LIMITED_PER_MINUTE");
    expect(fallen.rateLimitHits).toBeGreaterThan(ai.maxRetries);
  });

  it("retries non-LLM transient errors up to the attempt limit, ending in FALLBACK UNKNOWN", async () => {
    const ai = aiConfig({
      LLM_MAX_RETRIES: "2",
      LLM_RETRY_BASE_MS: "50",
      LLM_RETRY_MAX_MS: "100",
    });
    const campaignId = await createCampaign({ recipients: [{}] });
    const [recipient] = await recipientsOf(campaignId);

    await enqueue(campaignId, recipient.id, ai);

    let attemptsSeen = 0;
    const llm = {
      model: "mock-model",
      generateJson: async () => {
        attemptsSeen += 1;
        throw new TypeError("Transient network/prisma socket error");
      },
    } as unknown as MockLlmClient;

    startWorker(llm, ai);

    const fallen = await waitFor(async () => {
      const draft = await draftOf(campaignId, recipient.id);
      return draft?.status === "FALLBACK" ? draft : undefined;
    }, "the draft to fall back after non-LLM retries exhausted");

    expect(attemptsSeen).toBe(1 + MAX_RETRIES);
    expect(fallen.fallbackReason).toBe("UNKNOWN");
    expect(fallen.aiIntro).toBeNull();
  });

  it("re-enqueues and generates a draft whose job completed as SKIPPED_CAMPAIGN after campaign resumes", async () => {
    const ai = aiConfig();
    const campaignId = await createCampaign({ recipients: [{}] });
    const [recipient] = await recipientsOf(campaignId);

    // Pause the campaign before running the first job
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "PAUSED" },
    });

    const { draftId } = await enqueue(campaignId, recipient.id, ai);

    const llm = new MockLlmClient({ script: [{ kind: "success", intro: "Generated after resume" }] });
    const worker = startWorker(llm, ai);

    // First run finishes as SKIPPED_CAMPAIGN and job becomes completed in BullMQ
    await jobFinished(worker, draftId);

    const draftBefore = await draftOf(campaignId, recipient.id);
    expect(draftBefore?.status).toBe("PENDING");
    expect(llm.callCount).toBe(0);

    const completedJob = await queue.getJob(draftId);
    expect(await completedJob?.getState()).toBe("completed");

    // Resume the campaign
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "GENERATING" },
    });

    // Re-enqueue: removes completed job and adds new job
    await enqueue(campaignId, recipient.id, ai);

    const ready = await waitFor(async () => {
      const draft = await draftOf(campaignId, recipient.id);
      return draft?.status === "READY" ? draft : undefined;
    }, "the resumed draft to be generated");

    expect(ready.aiIntro).toBe("Generated after resume");
    expect(llm.callCount).toBe(1);
  });
});
