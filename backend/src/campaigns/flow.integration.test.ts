import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Queue, Worker } from "bullmq";
import type Redis from "ioredis";
import type { PrismaClient } from "../generated/prisma/client";
import type { AiConfig } from "../config/ai";
import { parseAiConfig } from "../config/ai";
import { MockLlmClient } from "../ai/llm/mock";
import { PROMPT_VERSION } from "../ai/prompts/personalize.v2";
import type { LlmLimiter } from "../ai/rateLimit/llmLimiter";
import type { GenerateDeps } from "../queue/generateWorker";
import type { GenerateJobData } from "../queue/generateJob";
import {
  approveSamples,
  InvalidInstructionError,
  refreshCampaign,
  regenerateSamples,
  scheduleCampaign,
  startSampling,
} from "./flow";
import { IllegalTransitionError } from "./stateMachine";
import { executeCampaignTickRun } from "./tick";

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
  } = {}): Promise<string> {
    const aiEnabled = options.aiEnabled ?? true;
    const aiInstruction = options.aiInstruction ?? "Helpful and professional.";
    const count = options.recipientsCount ?? 5;

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
      // First 3 recipients have personalization data, remaining may have thin data
      const hasData = i < 3;
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

    // Enqueue function fails after commit
    await expect(
      startSampling(campaignId, {
        db: prisma,
        ai,
        enqueue: async () => {
          throw new Error("Simulated enqueue failure");
        },
      })
    ).rejects.toThrow("Simulated enqueue failure");

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
    const campaignId = await createDraftCampaign({ recipientsCount: 3 });

    await startSampling(campaignId, { db: prisma, ai });
    await resolvePendingDrafts(campaignId, "Sample intro.", ai);
    await refreshCampaign(campaignId, { db: prisma, ai });
    await approveSamples(campaignId, {}, { db: prisma, ai });

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
    await approveSamples(campaignId, {}, { db: prisma, ai });
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
});
