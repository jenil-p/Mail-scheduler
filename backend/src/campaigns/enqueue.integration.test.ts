import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client";
import { draftId as computeDraftId, promptFingerprint } from "../ai/identity";
import { PROMPT_VERSION } from "../ai/prompts/personalize.v2";
import type { GenerateJobData } from "../queue/generateJob";

/**
 * `enqueueGenerate` against a real Postgres. Gated on TEST_DATABASE_URL so
 * `npm test` stays offline; run with `npm run test:integration` against a
 * throwaway database. All data here is fake.
 *
 * The queue is injected: these tests are about the draft row and the job payload,
 * not about BullMQ itself (that is covered in the generate worker's suite).
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl ? describe : describe.skip;

interface AddedJob {
  name: string;
  data: GenerateJobData;
  options: { jobId: string };
}

suite("enqueueGenerate (integration)", () => {
  let prisma: PrismaClient;
  let enqueueGenerate: typeof import("./enqueue").enqueueGenerate;
  let CampaignNotEnqueueableError: typeof import("./enqueue").CampaignNotEnqueueableError;
  let reconcileGeneration: typeof import("./enqueue").reconcileGeneration;

  const campaignIds: string[] = [];
  const added: AddedJob[] = [];

  const addJob = async (name: string, data: GenerateJobData, options: { jobId: string }) => {
    added.push({ name, data, options });
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;

    const [{ prisma: client }, enqueueModule] = await Promise.all([
      import("../db/pool"),
      import("./enqueue"),
    ]);

    prisma = client;
    enqueueGenerate = enqueueModule.enqueueGenerate;
    CampaignNotEnqueueableError = enqueueModule.CampaignNotEnqueueableError;
    reconcileGeneration = enqueueModule.reconcileGeneration;
  });

  afterAll(async () => {
    if (campaignIds.length > 0) {
      await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    }
    await prisma.$disconnect();
  });

  async function createCampaign(options: {
    withIdentity?: boolean;
    aiEnabled?: boolean;
  } = {}): Promise<string> {
    const aiInstruction = "Warm and specific.";
    const model = "mock-model";

    const campaign = await prisma.campaign.create({
      data: {
        userId: "integration-test@example.com",
        name: "Enqueue integration campaign",
        subjectTemplate: "Workshop invitation",
        bodyTemplate: "Hi {{first_name}},\n\n{{ai_intro}}\n\n{{unsubscribe_link}}",
        templateHash: `hash-${randomUUID()}`,
        linkUrl: "https://example.com/workshop",
        unsubscribeUrl: "https://example.com/unsubscribe",
        aiEnabled: options.aiEnabled ?? true,
        aiInstruction,
        promptFingerprint:
          options.withIdentity === false
            ? null
            : promptFingerprint({ promptTemplateVersion: PROMPT_VERSION, aiInstruction, llmModel: model }),
        llmModel: options.withIdentity === false ? null : model,
        promptTemplateVersion: options.withIdentity === false ? null : PROMPT_VERSION,
        scheduledAt: new Date(Date.now() + 3_600_000),
        status: "GENERATING",
      },
    });

    campaignIds.push(campaign.id);
    return campaign.id;
  }

  async function createRecipient(campaignId: string): Promise<string> {
    const recipient = await prisma.recipient.create({
      data: {
        campaignId,
        email: `recipient-${randomUUID()}@example.com`,
        firstName: "Priya",
        company: "Acme Corp",
        role: "Head of Ops",
        note: "met at a conference",
        hasPersonalizationData: true,
      },
    });

    return recipient.id;
  }

  it("creates a PENDING draft keyed by the deterministic id and adds one job", async () => {
    added.length = 0;

    const campaignId = await createCampaign();
    const recipientId = await createRecipient(campaignId);

    const result = await enqueueGenerate(campaignId, recipientId, {}, { db: prisma, addJob });

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    const expectedId = computeDraftId({
      campaignId,
      recipientId,
      templateHash: campaign!.templateHash,
      promptFingerprint: campaign!.promptFingerprint!,
    });

    expect(result).toEqual({
      draftId: expectedId,
      campaignId,
      recipientId,
      isSample: false,
    });

    const draft = await prisma.generatedDraft.findUnique({ where: { id: expectedId } });
    expect(draft).toMatchObject({
      id: expectedId,
      campaignId,
      recipientId,
      status: "PENDING",
      isSample: false,
      attempts: 0,
      aiIntro: null,
      subject: "",
      body: "",
      promptVersion: campaign!.promptFingerprint,
    });

    expect(added).toHaveLength(1);
    expect(added[0].name).toBe("generate-draft");
    // The worker reads recipient data from the database: the payload is ids only.
    expect(added[0].data).toEqual({
      draftId: expectedId,
      campaignId,
      recipientId,
      isSample: false,
    });
    expect(added[0].options.jobId).toBe(expectedId);
  });

  it("is a no-op the second time, including on a draft that already resolved", async () => {
    added.length = 0;

    const campaignId = await createCampaign();
    const recipientId = await createRecipient(campaignId);

    const first = await enqueueGenerate(campaignId, recipientId, {}, { db: prisma, addJob });

    // Pretend the workforce already finished this draft.
    const finished = await prisma.generatedDraft.update({
      where: { id: first.draftId },
      data: {
        status: "READY",
        aiIntro: "Already written",
        subject: "Subject",
        body: "Body",
        attempts: 1,
        resolvedBy: "USER",
      },
    });

    const second = await enqueueGenerate(campaignId, recipientId, {}, { db: prisma, addJob });

    expect(second.draftId).toBe(first.draftId);

    const after = await prisma.generatedDraft.findUnique({ where: { id: first.draftId } });
    expect(after).toEqual(finished); // untouched: no status reset, nothing cleared
    expect(await prisma.generatedDraft.count({ where: { campaignId } })).toBe(1);
  });

  it("records the sample flag and keeps the two sample and non-sample identities identical", async () => {
    added.length = 0;

    const campaignId = await createCampaign();
    const recipientId = await createRecipient(campaignId);

    const sample = await enqueueGenerate(campaignId, recipientId, { isSample: true }, { db: prisma, addJob });
    const nonSample = await enqueueGenerate(campaignId, recipientId, {}, { db: prisma, addJob });

    expect(nonSample.draftId).toBe(sample.draftId);

    const draft = await prisma.generatedDraft.findUnique({ where: { id: sample.draftId } });
    expect(draft?.isSample).toBe(true); // the first call created it, and re-adding never flips it
  });

  it("refuses a campaign without a frozen prompt identity", async () => {
    const campaignId = await createCampaign({ withIdentity: false });
    const recipientId = await createRecipient(campaignId);

    await expect(
      enqueueGenerate(campaignId, recipientId, {}, { db: prisma, addJob })
    ).rejects.toThrow(/no frozen prompt identity/);

    expect(await prisma.generatedDraft.count({ where: { campaignId } })).toBe(0);
  });

  it("refuses a campaign with AI disabled and a recipient from another campaign", async () => {
    const withoutAi = await createCampaign({ aiEnabled: false });
    const recipientOfOther = await createRecipient(withoutAi);

    await expect(
      enqueueGenerate(withoutAi, recipientOfOther, {}, { db: prisma, addJob })
    ).rejects.toThrow(CampaignNotEnqueueableError);

    const campaignId = await createCampaign();
    await expect(
      enqueueGenerate(campaignId, recipientOfOther, {}, { db: prisma, addJob })
    ).rejects.toThrow(/does not belong to campaign/);
  });

  it("throws for a campaign that does not exist", async () => {
    await expect(
      enqueueGenerate("cm_missing", "cr_missing", {}, { db: prisma, addJob })
    ).rejects.toThrow(/does not exist/);
  });

  it("leaves a PENDING draft when addJob fails, which reconcileGeneration recovers", async () => {
    const campaignId = await createCampaign();
    const recipientId = await createRecipient(campaignId);

    const failingAddJob = async () => {
      throw new Error("Redis connection dropped");
    };

    await expect(
      enqueueGenerate(campaignId, recipientId, {}, { db: prisma, addJob: failingAddJob })
    ).rejects.toThrow("Redis connection dropped");

    const draft = await prisma.generatedDraft.findFirst({ where: { campaignId, recipientId } });
    expect(draft?.status).toBe("PENDING");

    // Reconcile recovers the draft and enqueues the job
    const recoveredAdded: AddedJob[] = [];
    const recoverAddJob = async (name: string, data: GenerateJobData, options: { jobId: string }) => {
      recoveredAdded.push({ name, data, options });
    };

    const result = await reconcileGeneration(campaignId, {
      db: prisma,
      addJob: recoverAddJob,
      getJob: async () => undefined,
    });

    expect(result.reconciledCount).toBe(1);
    expect(result.draftIds).toContain(draft?.id);
    expect(recoveredAdded).toHaveLength(1);
    expect(recoveredAdded[0].options.jobId).toBe(draft?.id);
  });

  it("calling enqueueGenerate twice still yields one job and one draft", async () => {
    const campaignId = await createCampaign();
    const recipientId = await createRecipient(campaignId);

    const jobs: AddedJob[] = [];
    let jobState: string | undefined = undefined;

    const mockGetJob = async () =>
      jobState ? { getState: async () => jobState as string, remove: async () => undefined } : undefined;

    const mockAddJob = async (name: string, data: GenerateJobData, options: { jobId: string }) => {
      jobs.push({ name, data, options });
      jobState = "waiting";
    };

    const first = await enqueueGenerate(
      campaignId,
      recipientId,
      {},
      { db: prisma, addJob: mockAddJob, getJob: mockGetJob }
    );
    const second = await enqueueGenerate(
      campaignId,
      recipientId,
      {},
      { db: prisma, addJob: mockAddJob, getJob: mockGetJob }
    );

    expect(first.draftId).toBe(second.draftId);
    expect(jobs).toHaveLength(1); // Second call saw 'waiting' and skipped adding
    expect(await prisma.generatedDraft.count({ where: { campaignId } })).toBe(1);
  });
});
