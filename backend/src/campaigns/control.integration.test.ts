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
import { startSampling, approveSamples, refreshCampaign, scheduleCampaign } from "./flow";
import {
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  CancelNotSupportedYetError,
  IdentityMismatchError,
} from "./control";
import { reconcileSends } from "./reconcile";
import { emailQueue } from "../queue/queue";
import { IllegalTransitionError } from "./stateMachine";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testRedisHost = process.env.TEST_REDIS_HOST;
const testRedisPort = process.env.TEST_REDIS_PORT;

const suite = testDatabaseUrl && testRedisHost && testRedisPort ? describe : describe.skip;

suite("campaign control (integration)", () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let redisConnection: Redis;
  let queue: Queue<GenerateJobData>;
  let processGenerate: typeof import("../queue/generateWorker").processGenerate;
  let LlmLimiterClass: typeof import("../ai/rateLimit/llmLimiter").LlmLimiter;

  const campaignIds: string[] = [];

  let createGenerateWorker: typeof import("../queue/generateWorker").createGenerateWorker;
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
    processGenerate = workerModule.processGenerate;
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
        name: "Control Integration Campaign",
        subjectTemplate: "Product demo for {{first_name}}",
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

  it("pauses from SAMPLING, skips worker generation, resumes, reconciles, and finishes generation", async () => {
    const ai = aiConfig();
    const campaignId = await createDraftCampaign(2);

    // 1. Start sampling
    const startRes = await startSampling(campaignId, { db: prisma, ai });
    expect(startRes.ok).toBe(true);

    const draftId = startRes.draftIds[0];
    const job = await queue.getJob(draftId);
    expect(job).toBeDefined();

    // 2. Pause campaign
    const pauseRes = await pauseCampaign(campaignId, { db: prisma });
    expect(pauseRes.ok).toBe(true);

    const pausedCamp = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(pausedCamp.status).toBe("PAUSED");
    expect(pausedCamp.errorMessage).toBe("Paused by the user.");

    // 3. Worker picks up job while paused -> processGenerate returns SKIPPED_CAMPAIGN and job completes
    const llm = new MockLlmClient({
      script: [{ kind: "success", intro: "Personalized intro for your team." }],
    });

    const worker1 = startWorker(llm, ai);
    await jobFinished(worker1, draftId);
    await worker1.close();

    // Job is completed in BullMQ
    const finishedJob = await queue.getJob(draftId);
    expect(await finishedJob?.getState()).toBe("completed");

    // Draft remains PENDING in database
    const draftBeforeResume = await prisma.generatedDraft.findUniqueOrThrow({
      where: { id: draftId },
    });
    expect(draftBeforeResume.status).toBe("PENDING");

    // 4. Resume campaign (matching identity, approvedPromptVersion is null -> SAMPLING)
    const resumeRes = await resumeCampaign(campaignId, { db: prisma, ai });
    expect(resumeRes.ok).toBe(true);
    expect(resumeRes.status).toBe("SAMPLING");

    const resumedCamp = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(resumedCamp.status).toBe("SAMPLING");
    expect(resumedCamp.errorMessage).toBeNull();

    // Reconcile has removed the completed BullMQ job and re-enqueued it
    const reAddedJob = await queue.getJob(draftId);
    expect(reAddedJob).toBeDefined();
    const jobState = await reAddedJob!.getState();
    expect(["waiting", "delayed", "active", "prioritized"]).toContain(jobState);

    // 5. Worker processes the re-added job -> successfully generates!
    const worker2 = startWorker(llm, ai);
    await jobFinished(worker2, draftId);
    await worker2.close();

    const draftAfterResume = await prisma.generatedDraft.findUniqueOrThrow({
      where: { id: draftId },
    });
    expect(draftAfterResume.status).toBe("READY");
    expect(draftAfterResume.aiIntro).toBe("Personalized intro for your team.");
  });

  it("resumes with matching identity to GENERATING when approvedPromptVersion is set", async () => {
    const ai = aiConfig();
    const campaignId = await createDraftCampaign(2);

    await startSampling(campaignId, { db: prisma, ai });
    // Resolve sample drafts
    const sampleDrafts = await prisma.generatedDraft.findMany({ where: { campaignId } });
    for (const d of sampleDrafts) {
      await prisma.generatedDraft.update({
        where: { id: d.id },
        data: { status: "READY", aiIntro: "Sample intro" },
      });
    }

    await refreshCampaign(campaignId, { db: prisma });
    const campReview = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campReview.status).toBe("SAMPLE_REVIEW");

    // Approve samples -> moves to GENERATING
    await approveSamples(campaignId, {}, { db: prisma, ai, dailyUsage: 0 });
    const generatingCamp = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(generatingCamp.status).toBe("GENERATING");
    expect(generatingCamp.approvedPromptVersion).toBe(generatingCamp.promptFingerprint);

    // Pause from GENERATING
    await pauseCampaign(campaignId, { db: prisma });

    // Resume -> moves to GENERATING
    const resumeRes = await resumeCampaign(campaignId, { db: prisma, ai });
    expect(resumeRes.ok).toBe(true);
    expect(resumeRes.status).toBe("GENERATING");

    const campAfter = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campAfter.status).toBe("GENERATING");
    expect(campAfter.errorMessage).toBeNull();
  });

  it("resumes with identity change before approval: re-samples under new fingerprint", async () => {
    const ai = aiConfig();
    const campaignId = await createDraftCampaign(2);

    await startSampling(campaignId, { db: prisma, ai });
    const camp1 = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const oldFingerprint = camp1.promptFingerprint;
    expect(oldFingerprint).toBeTruthy();

    await pauseCampaign(campaignId, { db: prisma });

    // Resume with changed model identity before approval
    const newIdentity = {
      promptTemplateVersion: PROMPT_VERSION,
      llmModel: "different-model-v2",
    };

    const resumeRes = await resumeCampaign(campaignId, {
      db: prisma,
      identity: newIdentity,
      ai,
    });
    expect(resumeRes.ok).toBe(true);
    expect(resumeRes.status).toBe("SAMPLING");

    const camp2 = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(camp2.status).toBe("SAMPLING");
    expect(camp2.llmModel).toBe("different-model-v2");
    expect(camp2.promptFingerprint).not.toBe(oldFingerprint);

    // New drafts exist under new fingerprint
    const newDrafts = await prisma.generatedDraft.findMany({
      where: { campaignId, promptVersion: camp2.promptFingerprint! },
    });
    expect(newDrafts.length).toBeGreaterThan(0);

    // Old drafts are gone
    const oldDrafts = await prisma.generatedDraft.findMany({
      where: { campaignId, promptVersion: oldFingerprint! },
    });
    expect(oldDrafts.length).toBe(0);
  });

  it("resumes with identity change after approval: throws IDENTITY_MISMATCH_AFTER_APPROVAL and changes nothing", async () => {
    const ai = aiConfig();
    const campaignId = await createDraftCampaign(2);

    await startSampling(campaignId, { db: prisma, ai });
    const sampleDrafts = await prisma.generatedDraft.findMany({ where: { campaignId } });
    for (const d of sampleDrafts) {
      await prisma.generatedDraft.update({
        where: { id: d.id },
        data: { status: "READY", aiIntro: "Sample intro" },
      });
    }

    await refreshCampaign(campaignId, { db: prisma });
    await approveSamples(campaignId, {}, { db: prisma, ai, dailyUsage: 0 });

    await pauseCampaign(campaignId, { db: prisma });

    const newIdentity = {
      promptTemplateVersion: PROMPT_VERSION,
      llmModel: "different-model-v2",
    };

    const err = await resumeCampaign(campaignId, {
      db: prisma,
      identity: newIdentity,
      ai,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(IdentityMismatchError);
    expect((err as IdentityMismatchError).code).toBe("IDENTITY_MISMATCH_AFTER_APPROVAL");

    const campAfter = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campAfter.status).toBe("PAUSED");
    expect(campAfter.llmModel).toBe("mock-model");
  });

  it("cancelCampaign transitions allowed statuses to CANCELLED", async () => {
    const campaignId = await createDraftCampaign(1);

    // From DRAFT -> CANCELLED
    const cancelRes = await cancelCampaign(campaignId, { db: prisma });
    expect(cancelRes.ok).toBe(true);

    const cancelledCamp = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(cancelledCamp.status).toBe("CANCELLED");

    // From CANCELLED -> throws IllegalTransitionError
    await expect(cancelCampaign(campaignId, { db: prisma })).rejects.toThrow(IllegalTransitionError);
  });

  it("cancel from SCHEDULED and SENDING: deletes pending/rate_limited rows, keeps sent rows, sets drafts to HELD, removes queue jobs, and reconcileSends re-adds nothing", async () => {
    const ai = aiConfig({ SAMPLE_SIZE: "3" });
    const campaignId = await createDraftCampaign(3);

    // Sample and resolve drafts
    await startSampling(campaignId, { db: prisma, ai });
    const drafts = await prisma.generatedDraft.findMany({ where: { campaignId } });
    for (const d of drafts) {
      await prisma.generatedDraft.update({
        where: { id: d.id },
        data: { status: "READY", subject: "Sub", body: "Body" },
      });
    }

    // Move to GENERATING and schedule
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "GENERATING" },
    });

    await scheduleCampaign(campaignId, "GENERATING", { db: prisma, ai });

    const campScheduled = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campScheduled.status).toBe("SCHEDULED");

    const emailJobs = await prisma.emailJob.findMany({
      where: { generatedDraft: { campaignId } },
      orderBy: { id: "asc" },
    });
    expect(emailJobs).toHaveLength(3);

    // Set job 0: pending, job 1: rate_limited, job 2: sent
    await prisma.emailJob.update({
      where: { id: emailJobs[1].id },
      data: { status: "rate_limited" },
    });
    await prisma.emailJob.update({
      where: { id: emailJobs[2].id },
      data: { status: "sent", sentAt: new Date() },
    });

    // Verify BullMQ jobs exist in emailQueue
    expect(await emailQueue.getJob(emailJobs[0].id)).toBeDefined();
    expect(await emailQueue.getJob(emailJobs[1].id)).toBeDefined();
    expect(await emailQueue.getJob(emailJobs[2].id)).toBeDefined();

    // Cancel from SCHEDULED
    const cancelRes = await cancelCampaign(campaignId, { db: prisma });
    expect(cancelRes.ok).toBe(true);

    // Campaign is CANCELLED
    const cancelledCamp = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(cancelledCamp.status).toBe("CANCELLED");

    // Pending and rate_limited rows are deleted
    expect(await prisma.emailJob.findUnique({ where: { id: emailJobs[0].id } })).toBeNull();
    expect(await prisma.emailJob.findUnique({ where: { id: emailJobs[1].id } })).toBeNull();

    // Sent row is kept
    const keptJob = await prisma.emailJob.findUnique({ where: { id: emailJobs[2].id } });
    expect(keptJob).not.toBeNull();
    expect(keptJob?.status).toBe("sent");

    // Drafts for deleted jobs are HELD and emailJobId is null (via SetNull)
    const draft0 = await prisma.generatedDraft.findFirstOrThrow({ where: { recipientId: (await prisma.recipient.findMany({ where: { campaignId } }))[0].id } });
    const draft1 = await prisma.generatedDraft.findFirstOrThrow({ where: { recipientId: (await prisma.recipient.findMany({ where: { campaignId } }))[1].id } });
    const draft2 = await prisma.generatedDraft.findFirstOrThrow({ where: { recipientId: (await prisma.recipient.findMany({ where: { campaignId } }))[2].id } });

    // The two deleted jobs had drafts moved to HELD
    const heldDrafts = await prisma.generatedDraft.findMany({
      where: { campaignId, status: "HELD" },
    });
    expect(heldDrafts).toHaveLength(2);
    for (const hd of heldDrafts) {
      expect(hd.emailJobId).toBeNull();
    }

    // The sent draft was not touched
    const sentDraft = await prisma.generatedDraft.findUniqueOrThrow({ where: { emailJobId: emailJobs[2].id } });
    expect(sentDraft.status).toBe("QUEUED");

    // BullMQ jobs for deleted jobs are removed
    expect(await emailQueue.getJob(emailJobs[0].id)).toBeFalsy();
    expect(await emailQueue.getJob(emailJobs[1].id)).toBeFalsy();

    // Clean up sent job from queue
    const queueJob2 = await emailQueue.getJob(emailJobs[2].id);
    await queueJob2?.remove();

    // A following reconcileSends run re-adds nothing
    const reconcileOutcome = await reconcileSends(campaignId, { db: prisma });
    expect(reconcileOutcome.reconciledCount).toBe(0);
    expect(reconcileOutcome.jobIds).toEqual([]);

    // Now test cancel from SENDING as well
    const campSendingId = await createDraftCampaign(1);
    await startSampling(campSendingId, { db: prisma, ai });
    const draftSending = await prisma.generatedDraft.findFirstOrThrow({ where: { campaignId: campSendingId } });
    await prisma.generatedDraft.update({
      where: { id: draftSending.id },
      data: { status: "READY", subject: "Sub", body: "Body" },
    });
    await prisma.campaign.update({
      where: { id: campSendingId },
      data: { status: "GENERATING" },
    });
    await scheduleCampaign(campSendingId, "GENERATING", { db: prisma, ai });
    await prisma.campaign.update({
      where: { id: campSendingId },
      data: { status: "SENDING" },
    });

    const sendingEmailJob = await prisma.emailJob.findFirstOrThrow({
      where: { generatedDraft: { campaignId: campSendingId } },
    });
    expect(await emailQueue.getJob(sendingEmailJob.id)).toBeDefined();

    const cancelSendingRes = await cancelCampaign(campSendingId, { db: prisma });
    expect(cancelSendingRes.ok).toBe(true);

    const cancelledSendingCamp = await prisma.campaign.findUniqueOrThrow({ where: { id: campSendingId } });
    expect(cancelledSendingCamp.status).toBe("CANCELLED");
    expect(await prisma.emailJob.findUnique({ where: { id: sendingEmailJob.id } })).toBeNull();
    expect(await emailQueue.getJob(sendingEmailJob.id)).toBeFalsy();

    const draftSendingAfter = await prisma.generatedDraft.findUniqueOrThrow({ where: { id: draftSending.id } });
    expect(draftSendingAfter.status).toBe("HELD");
    expect(draftSendingAfter.emailJobId).toBeNull();

    const reconcileOutcome2 = await reconcileSends(campSendingId, { db: prisma });
    expect(reconcileOutcome2.reconciledCount).toBe(0);
  });
});
