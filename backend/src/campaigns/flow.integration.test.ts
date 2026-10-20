import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Queue, Worker } from "bullmq";
import type Redis from "ioredis";
import type { PrismaClient } from "../generated/prisma/client";
import type { AiConfig } from "../config/ai";
import { parseAiConfig } from "../config/ai";
import { MockLlmClient } from "../ai/llm/mock";
import { createLlmClient } from "../ai/llm";
import { PROMPT_VERSION } from "../ai/prompts/personalize.v2";
import type { LlmLimiter } from "../ai/rateLimit/llmLimiter";
import type { GenerateDeps } from "../queue/generateWorker";
import type { GenerateJobData } from "../queue/generateJob";
import {
  approveSamples,
  EmptyCampaignError,
  InvalidInstructionError,
  refreshCampaign,
  regenerateSamples,
  scheduleCampaign,
  startPlainCampaign,
  startSampling,
} from "./flow";
import { reconcileSends } from "./reconcile";
import { emailQueue } from "../queue/queue";
import { IllegalTransitionError } from "./stateMachine";
import { executeCampaignTickRun } from "./tick";
import { createDailyUsageGetter } from "./budget";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testRedisHost = process.env.TEST_REDIS_HOST;
const testRedisPort = process.env.TEST_REDIS_PORT;

const suite = testDatabaseUrl && testRedisHost && testRedisPort ? describe : describe.skip;

suite("campaign review flow (integration)", () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let redisConnection: Redis;
  let queue: Queue<GenerateJobData>;
  let processGenerate: typeof import("../queue/generateWorker").processGenerate;
  let LlmLimiterClass: typeof import("../ai/rateLimit/llmLimiter").LlmLimiter;

  const campaignIds: string[] = [];
  const workers: Worker[] = [];

  function aiConfig(overrides: Record<string, string> = {}): AiConfig {
    return parseAiConfig({
      AI_PERSONALIZATION_ENABLED: "true",
      LLM_PROVIDER: "mock",
      LLM_MODEL: "mock-model",
      LLM_RATE_LIMIT_PER_MIN: "1000",
      LLM_RATE_LIMIT_PER_DAY: "1000",
      LLM_DAILY_RESET_TZ: "UTC",
      LLM_MAX_RETRIES: "2",
      LLM_MAX_PARSE_RETRIES: "2",
      LLM_RETRY_BASE_MS: "20",
      LLM_RETRY_MAX_MS: "80",
      LLM_TIMEOUT_MS: "1000",
      GENERATE_CONCURRENCY: "1",
      SAMPLE_SIZE: "3",
      ...overrides,
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.REDIS_HOST = testRedisHost;
    process.env.REDIS_PORT = testRedisPort;

    const [
      { prisma: client },
      workerModule,
      queueModule,
      connectionModule,
      limiterModule,
      RedisModule,
    ] = await Promise.all([
      import("../db/pool"),
      import("../queue/generateWorker"),
      import("../queue/generateQueue"),
      import("../queue/queue"),
      import("../ai/rateLimit/llmLimiter"),
      import("ioredis"),
    ]);

    prisma = client;
    processGenerate = workerModule.processGenerate;
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
      await prisma.emailJob
        .deleteMany({
          where: { generatedDraft: { campaignId: { in: campaignIds } } },
        })
        .catch(() => undefined);
      await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    }
    await prisma.$disconnect();
  });

  afterEach(async () => {
    while (workers.length > 0) {
      const worker = workers.pop();
      await worker?.close().catch(() => undefined);
    }
    await redis.del("bull:generate:limiter");
    const keys = await redis.keys("llm:*");
    if (keys.length > 0) await redis.del(...keys);
  });

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

  async function createDraftCampaign(options: {
    recipientsCount?: number;
    aiEnabled?: boolean;
    aiInstruction?: string;
    allHaveData?: boolean;
  } = {}): Promise<string> {
    const aiEnabled = options.aiEnabled ?? true;
    const aiInstruction = options.aiInstruction ?? "Helpful and professional.";
    const count = options.recipientsCount ?? 5;
    const allHaveData = options.allHaveData ?? false;

    const campaign = await prisma.campaign.create({
      data: {
        userId: "integration@example.com",
        name: "Flow Integration Campaign",
        subjectTemplate: "Invitation to our product demo",
        bodyTemplate: "Hi {{first_name}},\n\n{{ai_intro}}\n\nWe hope to see you there!\n\n{{unsubscribe_link}}",
        templateHash: `hash-${randomUUID()}`,
        linkUrl: "https://example.com/demo",
        unsubscribeUrl: "https://example.com/unsubscribe",
        aiEnabled,
        aiInstruction,
        scheduledAt: new Date(Date.now() + 3_600_000),
        status: "DRAFT",
      },
    });

    campaignIds.push(campaign.id);

    const recipientData = Array.from({ length: count }, (_, i) => {
      // First 3 recipients have personalization data, remaining may have thin data unless allHaveData
      const hasData = allHaveData || i < 3;
      return {
        campaignId: campaign.id,
        email: `recipient-${i}-${randomUUID()}@example.com`,
        firstName: `Recipient${i}`,
        company: hasData ? `Company ${i}` : null,
        role: hasData ? `Role ${i}` : null,
        note: hasData ? `Note ${i}` : null,
        hasPersonalizationData: hasData,
      };
    });

    await prisma.recipient.createMany({ data: recipientData });

    return campaign.id;
  }

  async function resolvePendingDrafts(campaignId: string, intro: string, ai: AiConfig) {
    const drafts = await prisma.generatedDraft.findMany({
      where: { campaignId, status: "PENDING" },
    });

    const llm = new MockLlmClient({
      script: [{ kind: "success", intro }],
    });

    for (const draft of drafts) {
      await processGenerate(
        processedDeps(llm, ai),
        {
          id: draft.id,
          data: {
            draftId: draft.id,
            campaignId: draft.campaignId,
            recipientId: draft.recipientId,
            isSample: draft.isSample,
          },
          attemptsMade: 0,
          opts: { attempts: 3 },
        }
      );
    }
  }

  it("startSampling: creates expected sample set, drafts with isSample=true, status SAMPLING; illegal transition throws", async () => {
    const ai = aiConfig();
    const campaignId = await createDraftCampaign({ recipientsCount: 5 });

    const result = await startSampling(campaignId, { db: prisma, ai });
    expect(result.ok).toBe(true);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe("SAMPLING");
    expect(campaign.promptFingerprint).toBeTruthy();
    expect(campaign.llmModel).toBe(ai.model);
    expect(campaign.promptTemplateVersion).toBe(PROMPT_VERSION);

    const drafts = await prisma.generatedDraft.findMany({ where: { campaignId } });
    expect(drafts).toHaveLength(ai.sampleSize);
    for (const draft of drafts) {
      expect(draft.isSample).toBe(true);
      expect(draft.status).toBe("PENDING");
      expect(draft.promptVersion).toBe(campaign.promptFingerprint);
    }

    // Calling again from SAMPLING throws IllegalTransitionError
    await expect(startSampling(campaignId, { db: prisma, ai })).rejects.toThrow(
      IllegalTransitionError
    );

    // aiEnabled = false is rejected
    const nonAiCampaignId = await createDraftCampaign({ aiEnabled: false });
    await expect(startSampling(nonAiCampaignId, { db: prisma, ai })).rejects.toThrow(
      /AI personalization disabled/
    );
  });

  it("failure injection: if enqueue throws after commit, tick run recovers it and reaches SAMPLE_REVIEW", async () => {
    const ai = aiConfig();
    const campaignId = await createDraftCampaign({ recipientsCount: 4 });

    // Enqueue function fails after commit, but function resolves ok
    const result = await startSampling(campaignId, {
      db: prisma,
      ai,
      enqueue: async () => {
        throw new Error("Simulated enqueue failure");
      },
    });
    expect(result.ok).toBe(true);

    // Campaign is in SAMPLING with PENDING drafts in DB
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe("SAMPLING");

    const pendingDrafts = await prisma.generatedDraft.findMany({
      where: { campaignId, status: "PENDING" },
    });
    expect(pendingDrafts.length).toBeGreaterThan(0);

    // Resolve the drafts using processGenerate
    await resolvePendingDrafts(campaignId, "Personalized greeting.", ai);

    // Run tick: reconcile and refresh
    await executeCampaignTickRun({ db: prisma });

    const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(updated.status).toBe("SAMPLE_REVIEW");
  });

  it("regenerateSamples: deletes old drafts, stores new fingerprint, and resets to SAMPLING", async () => {
    const ai = aiConfig();
    const campaignId = await createDraftCampaign({ recipientsCount: 4 });

    await startSampling(campaignId, { db: prisma, ai });
    await resolvePendingDrafts(campaignId, "Initial sample intro.", ai);
    await refreshCampaign(campaignId, { db: prisma, ai });

    const initial = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(initial.status).toBe("SAMPLE_REVIEW");
    const oldFingerprint = initial.promptFingerprint;

    // Over-long instruction is rejected
    await expect(
      regenerateSamples(campaignId, { aiInstruction: "x".repeat(501) }, { db: prisma, ai })
    ).rejects.toThrow(InvalidInstructionError);

    // Empty string clears the instruction
    await regenerateSamples(campaignId, { aiInstruction: "" }, { db: prisma, ai });

    const regenerated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(regenerated.status).toBe("SAMPLING");
    expect(regenerated.aiInstruction).toBeNull();
    expect(regenerated.promptFingerprint).not.toBe(oldFingerprint);

    const drafts = await prisma.generatedDraft.findMany({ where: { campaignId } });
    expect(drafts.every((d) => d.promptVersion === regenerated.promptFingerprint)).toBe(true);
    expect(drafts.every((d) => d.status === "PENDING")).toBe(true);
  });

  it("approveSamples: BUDGET_WARNING returns without changing anything; with acknowledgement moves to GENERATING without duplicates", async () => {
    const ai = aiConfig({ SAMPLE_SIZE: "2" });
    const campaignId = await createDraftCampaign({ recipientsCount: 5 });

    await startSampling(campaignId, { db: prisma, ai });
    await resolvePendingDrafts(campaignId, "Nice intro.", ai);
    await refreshCampaign(campaignId, { db: prisma, ai });

    // Budget check: dailyLimit 10, usage 9 -> remaining 1. Needed is 3 (recipients with data) - 2 (already sampled) = 1?
    // Let's pass dailyLimit: 5, usage: 5 -> remaining 0. Needed > 0.
    const warning = await approveSamples(
      campaignId,
      { acknowledgeBudgetWarning: false },
      { db: prisma, dailyLimit: 5, dailyUsage: 5 }
    );

    expect(warning.ok).toBe(false);
    if (!warning.ok) {
      expect(warning.code).toBe("BUDGET_WARNING");
      expect(warning.remaining).toBe(0);
    }

    // No changes were made
    let campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe("SAMPLE_REVIEW");

    // With acknowledgement, approval proceeds
    const approved = await approveSamples(
      campaignId,
      { acknowledgeBudgetWarning: true },
      { db: prisma, dailyLimit: 5, dailyUsage: 5 }
    );
    expect(approved.ok).toBe(true);

    campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe("GENERATING");
    expect(campaign.approvedPromptVersion).toBe(campaign.promptFingerprint);

    // Every recipient now has a draft
    const totalRecipients = await prisma.recipient.count({ where: { campaignId } });
    const totalDrafts = await prisma.generatedDraft.count({ where: { campaignId } });
    expect(totalDrafts).toBe(totalRecipients);

    // Calling approveSamples again throws IllegalTransitionError and does not create duplicates
    await expect(
      approveSamples(campaignId, { acknowledgeBudgetWarning: true }, { db: prisma })
    ).rejects.toThrow(IllegalTransitionError);

    const draftsAfter = await prisma.generatedDraft.count({ where: { campaignId } });
    expect(draftsAfter).toBe(totalRecipients);
  });

  it("status progression: GENERATING with flagged -> EXCEPTION_REVIEW; EXCEPTION_REVIEW without flagged -> SCHEDULED", async () => {
    const ai = aiConfig({ SAMPLE_SIZE: "2" });
    const campaignId = await createDraftCampaign({ recipientsCount: 4, allHaveData: true });

    await startSampling(campaignId, { db: prisma, ai });
    await resolvePendingDrafts(campaignId, "Sample intro.", ai);
    await refreshCampaign(campaignId, { db: prisma, ai });
    await approveSamples(
      campaignId,
      {},
      { db: prisma, ai, getDailyUsage: createDailyUsageGetter(mkLimiter(ai), ai.provider) }
    );

    // Resolve drafts: make one draft FLAGGED by returning a banned phrase
    const pendingDrafts = await prisma.generatedDraft.findMany({
      where: { campaignId, status: "PENDING" },
    });

    // First draft clean intro
    const cleanLlm = new MockLlmClient({
      script: [{ kind: "success", intro: "Clean intro." }],
    });
    await processGenerate(
      processedDeps(cleanLlm, ai),
      {
        id: pendingDrafts[0].id,
        data: {
          draftId: pendingDrafts[0].id,
          campaignId: pendingDrafts[0].campaignId,
          recipientId: pendingDrafts[0].recipientId,
          isSample: pendingDrafts[0].isSample,
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      }
    );

    // If there is another draft, flag it with a banned phrase
    if (pendingDrafts.length > 1) {
      const flaggedLlm = new MockLlmClient({
        script: [{ kind: "success", intro: "Join our webinar today!" }], // "webinar" is banned
      });
      await processGenerate(
        processedDeps(flaggedLlm, ai),
        {
          id: pendingDrafts[1].id,
          data: {
            draftId: pendingDrafts[1].id,
            campaignId: pendingDrafts[1].campaignId,
            recipientId: pendingDrafts[1].recipientId,
            isSample: pendingDrafts[1].isSample,
          },
          attemptsMade: 0,
          opts: { attempts: 3 },
        }
      );
    }

    // refreshCampaign: with flagged draft -> EXCEPTION_REVIEW
    const outcome1 = await refreshCampaign(campaignId, { db: prisma, ai });
    expect(outcome1).toEqual({
      refreshed: true,
      from: "GENERATING",
      to: "EXCEPTION_REVIEW",
    });

    let campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe("EXCEPTION_REVIEW");

    // Resolve the flagged draft to APPROVED (simulating reviewer resolution in Phase 7)
    await prisma.generatedDraft.updateMany({
      where: { campaignId, status: "FLAGGED" },
      data: { status: "APPROVED" },
    });

    // refreshCampaign: no flagged left -> SCHEDULED
    const outcome2 = await refreshCampaign(campaignId, { db: prisma, ai });
    expect(outcome2).toEqual({
      refreshed: true,
      from: "EXCEPTION_REVIEW",
      to: "SCHEDULED",
    });

    campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe("SCHEDULED");
  });

  it("two concurrent refreshCampaign calls call scheduleCampaign exactly once", async () => {
    const ai = aiConfig({ SAMPLE_SIZE: "2" });
    const campaignId = await createDraftCampaign({ recipientsCount: 2 });

    await startSampling(campaignId, { db: prisma, ai });
    await resolvePendingDrafts(campaignId, "Intro.", ai);
    await refreshCampaign(campaignId, { db: prisma, ai });
    await approveSamples(
      campaignId,
      {},
      { db: prisma, ai, getDailyUsage: createDailyUsageGetter(mkLimiter(ai), ai.provider) }
    );
    await resolvePendingDrafts(campaignId, "Intro.", ai);

    // Campaign is in GENERATING with all drafts resolved to READY (none flagged)
    const [res1, res2] = await Promise.all([
      refreshCampaign(campaignId, { db: prisma, ai }),
      refreshCampaign(campaignId, { db: prisma, ai }),
    ]);

    const scheduledResults = [res1, res2].filter((r) => r.refreshed && r.to === "SCHEDULED");
    expect(scheduledResults).toHaveLength(1);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe("SCHEDULED");
  });

  it("live identity: provider mock with no LLM_MODEL resolves drafts without pausing campaign", async () => {
    const ai = parseAiConfig({
      AI_PERSONALIZATION_ENABLED: "true",
      LLM_PROVIDER: "mock",
      // LLM_MODEL deliberately omitted
      LLM_RATE_LIMIT_PER_MIN: "1000",
      LLM_RATE_LIMIT_PER_DAY: "1000",
      LLM_DAILY_RESET_TZ: "UTC",
      SAMPLE_SIZE: "2",
    });

    const campaignId = await createDraftCampaign({ recipientsCount: 2, allHaveData: true });

    // startSampling with NO injected identity
    const samplingResult = await startSampling(campaignId, { db: prisma, ai });
    expect(samplingResult.ok).toBe(true);

    const client = createLlmClient(ai);
    const drafts = await prisma.generatedDraft.findMany({
      where: { campaignId, status: "PENDING" },
    });
    expect(drafts).toHaveLength(2);

    for (const draft of drafts) {
      const res = await processGenerate(
        processedDeps(client as MockLlmClient, ai),
        {
          id: draft.id,
          data: {
            draftId: draft.id,
            campaignId: draft.campaignId,
            recipientId: draft.recipientId,
            isSample: draft.isSample,
          },
          attemptsMade: 0,
          opts: { attempts: 3 },
        }
      );
      expect(res.outcome).not.toBe("PAUSED_VERSION_MISMATCH");
    }

    const updatedCampaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(updatedCampaign.status).not.toBe("PAUSED");
    expect(updatedCampaign.status).toBe("SAMPLING");

    const resolvedDrafts = await prisma.generatedDraft.findMany({
      where: { campaignId },
    });
    expect(resolvedDrafts).toHaveLength(2);
    expect(resolvedDrafts.every((d) => d.status === "READY" || d.status === "FLAGGED")).toBe(true);
  });

  describe("scheduleCampaign (Phase 6a integration)", () => {
    it("only READY/APPROVED/FALLBACK drafts get EmailJobs; HELD and FLAGGED do not; drafts become QUEUED with emailJobId set; second call creates nothing", async () => {
      const ai = aiConfig({ SAMPLE_SIZE: "5" });
      const campaignId = await createDraftCampaign({ recipientsCount: 5, allHaveData: true });

      await startSampling(campaignId, { db: prisma, ai });
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      const drafts = await prisma.generatedDraft.findMany({
        where: { campaignId },
        include: { recipient: true },
        orderBy: { createdAt: "asc" },
      });
      expect(drafts).toHaveLength(5);

      // d0: READY, d1: APPROVED, d2: FALLBACK, d3: HELD, d4: FLAGGED
      await prisma.generatedDraft.update({
        where: { id: drafts[0].id },
        data: { status: "READY", subject: "Subject 0", body: "Body 0" },
      });
      await prisma.generatedDraft.update({
        where: { id: drafts[1].id },
        data: { status: "APPROVED", subject: "Subject 1", body: "Body 1" },
      });
      await prisma.generatedDraft.update({
        where: { id: drafts[2].id },
        data: { status: "FALLBACK", fallbackReason: "USER_PLAIN", subject: "Subject 2", body: "Body 2" },
      });
      await prisma.generatedDraft.update({
        where: { id: drafts[3].id },
        data: { status: "HELD", subject: "Subject 3", body: "Body 3" },
      });
      await prisma.generatedDraft.update({
        where: { id: drafts[4].id },
        data: { status: "FLAGGED", subject: "Subject 4", body: "Body 4" },
      });

      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: "GENERATING" },
      });

      const moved = await scheduleCampaign(campaignId, "GENERATING", { db: prisma, ai });
      expect(moved).toBe(true);

      const updatedCampaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(updatedCampaign.status).toBe("SCHEDULED");

      const updatedDrafts = await prisma.generatedDraft.findMany({
        where: { campaignId },
        include: { emailJob: true, recipient: true },
      });

      const d0 = updatedDrafts.find((d) => d.id === drafts[0].id)!;
      const d1 = updatedDrafts.find((d) => d.id === drafts[1].id)!;
      const d2 = updatedDrafts.find((d) => d.id === drafts[2].id)!;
      const d3 = updatedDrafts.find((d) => d.id === drafts[3].id)!;
      const d4 = updatedDrafts.find((d) => d.id === drafts[4].id)!;

      // d0 (READY), d1 (APPROVED), d2 (FALLBACK) -> QUEUED with EmailJob created
      expect(d0.status).toBe("QUEUED");
      expect(d0.emailJobId).toBeTruthy();
      expect(d0.emailJob).toMatchObject({
        userId: campaign.userId,
        recipientEmail: drafts[0].recipient.email,
        subject: "Subject 0",
        body: "Body 0",
        senderEmail: "Sendly Scheduler <scheduler@sendly.local>",
        status: "pending",
      });

      expect(d1.status).toBe("QUEUED");
      expect(d1.emailJobId).toBeTruthy();
      expect(d1.emailJob?.subject).toBe("Subject 1");
      expect(d1.emailJob?.body).toBe("Body 1");

      expect(d2.status).toBe("QUEUED");
      expect(d2.emailJobId).toBeTruthy();
      expect(d2.emailJob?.subject).toBe("Subject 2");
      expect(d2.emailJob?.body).toBe("Body 2");

      // d3 (HELD) and d4 (FLAGGED) do not get EmailJobs
      expect(d3.status).toBe("HELD");
      expect(d3.emailJobId).toBeNull();

      expect(d4.status).toBe("FLAGGED");
      expect(d4.emailJobId).toBeNull();

      // Second call creates nothing and returns false
      const secondCall = await scheduleCampaign(campaignId, "GENERATING", { db: prisma, ai });
      expect(secondCall).toBe(false);

      const jobCount = await prisma.emailJob.count({
        where: { generatedDraft: { campaignId } },
      });
      expect(jobCount).toBe(3);
    });

    it("two concurrent scheduleCampaign calls create each EmailJob once", async () => {
      const ai = aiConfig({ SAMPLE_SIZE: "2" });
      const campaignId = await createDraftCampaign({ recipientsCount: 2, allHaveData: true });

      await startSampling(campaignId, { db: prisma, ai });
      const drafts = await prisma.generatedDraft.findMany({ where: { campaignId } });
      for (const d of drafts) {
        await prisma.generatedDraft.update({
          where: { id: d.id },
          data: { status: "READY", subject: "Sub", body: "Body" },
        });
      }

      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: "GENERATING" },
      });

      const [res1, res2] = await Promise.all([
        scheduleCampaign(campaignId, "GENERATING", { db: prisma, ai }),
        scheduleCampaign(campaignId, "GENERATING", { db: prisma, ai }),
      ]);

      const successCount = [res1, res2].filter(Boolean).length;
      expect(successCount).toBe(1);

      const jobs = await prisma.emailJob.findMany({
        where: { generatedDraft: { campaignId } },
      });
      expect(jobs).toHaveLength(2);
    });

    it("a failing enqueue leaves pending EmailJob rows and one reconcileSends run adds the jobs", async () => {
      const ai = aiConfig({ SAMPLE_SIZE: "1" });
      const campaignId = await createDraftCampaign({ recipientsCount: 1, allHaveData: true });

      await startSampling(campaignId, { db: prisma, ai });
      const [draft] = await prisma.generatedDraft.findMany({ where: { campaignId } });
      await prisma.generatedDraft.update({
        where: { id: draft.id },
        data: { status: "READY", subject: "Fail Enqueue Sub", body: "Fail Enqueue Body" },
      });

      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: "GENERATING" },
      });

      const failingAddSendJob = vi.fn().mockRejectedValue(new Error("Queue error"));
      const logger = { error: vi.fn(), info: vi.fn() };

      const moved = await scheduleCampaign(campaignId, "GENERATING", {
        db: prisma,
        ai,
        addSendJob: failingAddSendJob,
        logger,
      });

      expect(moved).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("send enqueue failed: Error"));

      const [updatedDraft] = await prisma.generatedDraft.findMany({
        where: { campaignId },
        include: { emailJob: true },
      });
      expect(updatedDraft.status).toBe("QUEUED");
      expect(updatedDraft.emailJob).toBeDefined();
      expect(updatedDraft.emailJob?.status).toBe("pending");

      // Verify that reconcileSends finds the pending row and adds the send job to the real queue
      const reconcileResult = await reconcileSends(campaignId, { db: prisma });
      expect(reconcileResult.reconciledCount).toBe(1);
      expect(reconcileResult.jobIds).toContain(updatedDraft.emailJob!.id);

      const bullJob = await emailQueue.getJob(updatedDraft.emailJob!.id);
      expect(bullJob).toBeDefined();
      expect(bullJob?.data.jobId).toBe(updatedDraft.emailJob!.id);
    });
  });

  describe("startPlainCampaign (Phase 6a integration)", () => {
    it("startPlainCampaign end to end with aiEnabled false", async () => {
      const ai = aiConfig();
      const campaignId = await createDraftCampaign({ recipientsCount: 2, aiEnabled: false });

      const res = await startPlainCampaign(campaignId, { db: prisma, ai });
      expect(res.ok).toBe(true);
      expect(res.createdJobsCount).toBe(2);

      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(campaign.status).toBe("SCHEDULED");
      expect(campaign.promptFingerprint).toBe("none");

      const drafts = await prisma.generatedDraft.findMany({
        where: { campaignId },
        include: { emailJob: true, recipient: true },
      });

      expect(drafts).toHaveLength(2);
      for (const d of drafts) {
        expect(d.status).toBe("QUEUED");
        expect(d.fallbackReason).toBe("AI_DISABLED");
        expect(d.promptVersion).toBe("none");
        expect(d.isSample).toBe(false);
        expect(d.emailJobId).toBeTruthy();
        expect(d.emailJob?.status).toBe("pending");
        expect(d.emailJob?.senderEmail).toBe("Sendly Scheduler <scheduler@sendly.local>");
        expect(d.emailJob?.recipientEmail).toBe(d.recipient.email);
        expect(d.emailJob?.body).not.toContain("{{ai_intro}}");
        expect(d.emailJob?.body).toContain("We hope to see you there!");

        // Check send queue job in Redis
        const queueJob = await emailQueue.getJob(d.emailJobId!);
        expect(queueJob).toBeDefined();
        expect(queueJob?.data.jobId).toBe(d.emailJobId);
      }
    });

    it("throws EmptyCampaignError when campaign has zero recipients", async () => {
      const ai = aiConfig();
      const campaignId = await createDraftCampaign({ recipientsCount: 0, aiEnabled: false });

      await expect(startPlainCampaign(campaignId, { db: prisma, ai })).rejects.toThrow(
        EmptyCampaignError
      );
    });
  });

  describe("reconcileSends (Phase 6a integration)", () => {
    it("reconcileSends ignores rate_limited, sent and failed rows", async () => {
      const ai = aiConfig({ SAMPLE_SIZE: "4" });
      const campaignId = await createDraftCampaign({ recipientsCount: 4, allHaveData: true });

      await startSampling(campaignId, { db: prisma, ai });
      const drafts = await prisma.generatedDraft.findMany({
        where: { campaignId },
        include: { recipient: true },
      });

      for (const d of drafts) {
        await prisma.generatedDraft.update({
          where: { id: d.id },
          data: { status: "READY", subject: "S", body: "B" },
        });
      }

      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: "GENERATING" },
      });

      await scheduleCampaign(campaignId, "GENERATING", { db: prisma, ai });

      const emailJobs = await prisma.emailJob.findMany({
        where: { generatedDraft: { campaignId } },
      });
      expect(emailJobs).toHaveLength(4);

      // Set different EmailJob statuses
      // j0: pending, j1: rate_limited, j2: sent, j3: failed
      await prisma.emailJob.update({
        where: { id: emailJobs[1].id },
        data: { status: "rate_limited" },
      });
      await prisma.emailJob.update({
        where: { id: emailJobs[2].id },
        data: { status: "sent", sentAt: new Date() },
      });
      await prisma.emailJob.update({
        where: { id: emailJobs[3].id },
        data: { status: "failed", errorMessage: "SMTP error" },
      });

      // Remove all jobs from BullMQ send queue
      for (const j of emailJobs) {
        const job = await emailQueue.getJob(j.id);
        await job?.remove();
      }

      const reconcileResult = await reconcileSends(campaignId, { db: prisma });

      // ONLY the pending job (j0) should be reconciled
      expect(reconcileResult.reconciledCount).toBe(1);
      expect(reconcileResult.jobIds).toEqual([emailJobs[0].id]);

      // j0 is re-added, j1, j2, j3 are NOT added
      expect(await emailQueue.getJob(emailJobs[0].id)).toBeDefined();
      expect(await emailQueue.getJob(emailJobs[1].id)).toBeFalsy();
      expect(await emailQueue.getJob(emailJobs[2].id)).toBeFalsy();
      expect(await emailQueue.getJob(emailJobs[3].id)).toBeFalsy();
    });
  });
});
