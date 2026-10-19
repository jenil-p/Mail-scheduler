import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Queue, Worker } from "bullmq";
import type Redis from "ioredis";
import type { PrismaClient } from "../generated/prisma/client";
import type { AiConfig } from "../config/ai";
import { parseAiConfig } from "../config/ai";
import { MockLlmClient } from "../ai/llm/mock";
import type { LlmLimiter } from "../ai/rateLimit/llmLimiter";
import type { GenerateJobData } from "../queue/generateJob";
import { startSampling, approveSamples, refreshCampaign } from "./flow";
import {
  resolveDraft,
  bulkResolve,
  listDrafts,
  getCampaignSummary,
  CampaignNotUnderReviewError,
  StaleDraftError,
} from "./drafts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testRedisHost = process.env.TEST_REDIS_HOST;
const testRedisPort = process.env.TEST_REDIS_PORT;

const suite = testDatabaseUrl && testRedisHost && testRedisPort ? describe : describe.skip;

suite("campaign drafts resolution (integration)", () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let redisConnection: Redis;
  let queue: Queue<GenerateJobData>;
  let createGenerateWorker: typeof import("../queue/generateWorker").createGenerateWorker;
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
      SAMPLE_SIZE: "2",
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
    createGenerateWorker = workerModule.createGenerateWorker;
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

  function jobFinished(worker: Worker, draftId: string): Promise<void> {
    return new Promise((resolve) => {
      worker.on("completed", (job: any) => {
        if ((job.data as GenerateJobData).draftId === draftId) resolve();
      });
    });
  }

  async function createDraftCampaign(count = 3): Promise<string> {
    const campaign = await prisma.campaign.create({
      data: {
        userId: "integration@example.com",
        name: "Drafts Integration Campaign",
        subjectTemplate: "Invitation for {{first_name}}",
        bodyTemplate: "Hi {{first_name}},\n\n{{ai_intro}}\n\nBest regards,\n{{unsubscribe_link}}",
        templateHash: `hash-${randomUUID()}`,
        linkUrl: "https://example.com/demo",
        unsubscribeUrl: "https://example.com/unsubscribe",
        aiEnabled: true,
        aiInstruction: "Friendly and professional.",
        scheduledAt: new Date(Date.now() + 3_600_000),
        status: "DRAFT",
      },
    });

    campaignIds.push(campaign.id);

    const recipientData = Array.from({ length: count }, (_, i) => ({
      campaignId: campaign.id,
      email: `recipient-${i}-${randomUUID()}@example.com`,
      firstName: `First${i}`,
      company: `Company ${i}`,
      role: `Role ${i}`,
      note: `Note ${i}`,
      hasPersonalizationData: true,
    }));

    await prisma.recipient.createMany({ data: recipientData });
    return campaign.id;
  }

  it("progresses to EXCEPTION_REVIEW on flagged drafts, resolves drafts, and transitions to SCHEDULED", async () => {
    const ai = aiConfig({ SAMPLE_SIZE: "1" });
    const campaignId = await createDraftCampaign(3);

    // 1. Start sampling
    const samplingRes = await startSampling(campaignId, { db: prisma, ai });
    expect(samplingRes.ok).toBe(true);

    // 2. Resolve sample draft with a valid intro
    const sampleDraftId = samplingRes.draftIds[0];
    const llmSample = new MockLlmClient({
      script: [{ kind: "success", intro: "Personalized intro for sample recipient." }],
    });
    const sampleWorker = startWorker(llmSample, ai);
    await jobFinished(sampleWorker, sampleDraftId);
    await sampleWorker.close();

    // 3. Refresh -> SAMPLE_REVIEW
    await refreshCampaign(campaignId, { db: prisma });
    const campReview = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campReview.status).toBe("SAMPLE_REVIEW");

    // 4. Approve samples -> GENERATING
    await approveSamples(campaignId, {}, { db: prisma, ai, dailyUsage: 0 });
    const campGenerating = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campGenerating.status).toBe("GENERATING");

    // 5. Worker processes remaining 2 drafts: one gets flagged with banned phrase ("demo"), one gets unflagged
    const remainingDrafts = await prisma.generatedDraft.findMany({
      where: { campaignId, isSample: false },
    });
    expect(remainingDrafts).toHaveLength(2);

    const llmRemaining = new MockLlmClient({
      script: [
        { kind: "success", intro: "We would love to invite you to a demo." }, // BANNED_PHRASE "demo"
        { kind: "success", intro: "Personalized intro for team two." },
      ],
    });

    const genWorker = startWorker(llmRemaining, ai);
    for (const d of remainingDrafts) {
      await jobFinished(genWorker, d.id);
    }
    await genWorker.close();

    // 6. Refresh campaign -> transitions to EXCEPTION_REVIEW because 1 draft is FLAGGED
    await refreshCampaign(campaignId, { db: prisma });
    const campException = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campException.status).toBe("EXCEPTION_REVIEW");

    const flaggedDraft = await prisma.generatedDraft.findFirstOrThrow({
      where: { campaignId, status: "FLAGGED" },
    });
    expect(flaggedDraft.flagReasons).toBeTruthy();

    // 7. Test resolveDraft: edit-still-bad keeps draft FLAGGED
    const editBadRes = await resolveDraft(flaggedDraft.id, {
      type: "edit",
      aiIntro: "Hi there, another demo invite.",
    }, { db: prisma, ai });

    expect(editBadRes.applied).toBe(true);
    expect(editBadRes.status).toBe("FLAGGED");

    const draftStillBad = await prisma.generatedDraft.findUniqueOrThrow({
      where: { id: flaggedDraft.id },
    });
    expect(draftStillBad.status).toBe("FLAGGED");

    // Campaign is still in EXCEPTION_REVIEW
    const campStillReview = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campStillReview.status).toBe("EXCEPTION_REVIEW");

    // 8. Test resolveDraft: edit-clean approves draft, and refreshCampaign transitions EXCEPTION_REVIEW -> SCHEDULED!
    const editCleanRes = await resolveDraft(flaggedDraft.id, {
      type: "edit",
      aiIntro: "Personalized intro for your team.",
    }, { db: prisma, ai });

    expect(editCleanRes.applied).toBe(true);
    expect(editCleanRes.status).toBe("APPROVED");
    expect(editCleanRes.flagReasons).toEqual([]);

    // Because all drafts are now resolved (READY or APPROVED), refreshCampaign automatically moved campaign to SCHEDULED!
    const campScheduled = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campScheduled.status).toBe("SCHEDULED");

    // 9. Verify getCampaignSummary counts
    const summary = await getCampaignSummary(campaignId, { db: prisma });
    expect(summary.status).toBe("SCHEDULED");
    expect(summary.recipientCount).toBe(3);
    expect(summary.draftCounts.FLAGGED).toBe(0);
    expect(summary.draftCounts.APPROVED).toBe(1);
    expect(summary.draftCounts.READY).toBe(2);

    // 10. Verify listDrafts paging and filters
    const allDraftsList = await listDrafts(campaignId, {}, { db: prisma });
    expect(allDraftsList).toHaveLength(3);

    const approvedList = await listDrafts(campaignId, { status: "APPROVED" }, { db: prisma });
    expect(approvedList).toHaveLength(1);
    expect(approvedList[0].id).toBe(flaggedDraft.id);
    expect(approvedList[0].resolvedBy).toBe("USER");
    expect(approvedList[0].recipient.email).toBeTruthy();
  });

  it("bulkResolve resolves all flagged drafts and transitions EXCEPTION_REVIEW -> SCHEDULED", async () => {
    const ai = aiConfig({ SAMPLE_SIZE: "1" });
    const campaignId = await createDraftCampaign(3);

    // Prepare campaign directly in EXCEPTION_REVIEW with current prompt fingerprint
    const fp = "bulk-test-fingerprint";
    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: "EXCEPTION_REVIEW",
        promptFingerprint: fp,
        approvedPromptVersion: fp,
      },
    });

    const recipients = await prisma.recipient.findMany({ where: { campaignId } });

    // Create 2 FLAGGED drafts and 1 READY draft
    await prisma.generatedDraft.createMany({
      data: [
        {
          id: `draft-flag-1-${randomUUID()}`,
          campaignId,
          recipientId: recipients[0].id,
          status: "FLAGGED",
          promptVersion: fp,
          subject: "Sub 1",
          body: "Body 1",
          aiIntro: "Intro 1",
          flagReasons: [{ code: "BANNED_PHRASE", detail: "demo" }],
        },
        {
          id: `draft-flag-2-${randomUUID()}`,
          campaignId,
          recipientId: recipients[1].id,
          status: "FLAGGED",
          promptVersion: fp,
          subject: "Sub 2",
          body: "Body 2",
          aiIntro: "Intro 2",
          flagReasons: [{ code: "TOO_LONG", detail: "too long" }],
        },
        {
          id: `draft-ready-${randomUUID()}`,
          campaignId,
          recipientId: recipients[2].id,
          status: "READY",
          promptVersion: fp,
          subject: "Sub 3",
          body: "Body 3",
          aiIntro: "Intro 3",
        },
      ],
    });

    // 1. Bulk resolve with codes filter for BANNED_PHRASE
    const count1 = await bulkResolve(campaignId, {
      type: "approve",
      codes: ["BANNED_PHRASE"],
    }, { db: prisma });

    expect(count1).toBe(1);

    // 1 FLAGGED draft remains -> campaign still in EXCEPTION_REVIEW
    const campStillReview = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campStillReview.status).toBe("EXCEPTION_REVIEW");

    // 2. Bulk resolve remaining FLAGGED draft using use_plain
    const count2 = await bulkResolve(campaignId, {
      type: "use_plain",
    }, { db: prisma });

    expect(count2).toBe(1);

    // No FLAGGED drafts remain -> refreshCampaign moved campaign to SCHEDULED!
    const campScheduled = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campScheduled.status).toBe("SCHEDULED");

    const summary = await getCampaignSummary(campaignId, { db: prisma });
    expect(summary.status).toBe("SCHEDULED");
    expect(summary.draftCounts.FLAGGED).toBe(0);
    expect(summary.draftCounts.APPROVED).toBe(1);
    expect(summary.draftCounts.FALLBACK).toBe(1);
    expect(summary.draftCounts.READY).toBe(1);
  });
});
