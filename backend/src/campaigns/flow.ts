/**
 * Campaign review flow and lifecycle operations (spec Phase 5a).
 *
 * Functions:
 * - `startSampling`: freeze identity, select sample drafts, move DRAFT -> SAMPLING, enqueue.
 * - `regenerateSamples`: delete drafts, update instruction, recompute identity, move SAMPLE_REVIEW -> SAMPLING, enqueue.
 * - `approveSamples`: check budget, create remaining drafts, freeze approvedPromptVersion, move SAMPLE_REVIEW -> GENERATING, enqueue.
 * - `refreshCampaign`: DB-driven status progression (SAMPLING -> SAMPLE_REVIEW, GENERATING -> EXCEPTION_REVIEW / SCHEDULED, EXCEPTION_REVIEW -> SCHEDULED).
 * - `scheduleCampaign`: SEAM transitioned to SCHEDULED.
 *
 * Guarantees:
 * - DB state change and draft row creation happen in ONE transaction.
 * - Drafts exist if and only if state moved.
 * - Enqueue happens AFTER commit; failures leave drafts PENDING for reconcileGeneration.
 * - Fully dependency-injected for testability.
 */

import type { PrismaClient, CampaignStatus } from "../generated/prisma/client";
import type { AiConfig } from "../config/ai";
import { config } from "../config";
import { draftId, promptFingerprint } from "../ai/identity";
import { PROMPT_VERSION } from "../ai/prompts/personalize.v2";
import { resolveModelName } from "../ai/llm";
import { selectSampleRecipients } from "./sampling";
import { listRecipients } from "./recipients";
import { transition, IllegalTransitionError } from "./stateMachine";
import { getGenerateQueue } from "../queue/generateQueue";
import { ensureGenerateJob } from "./reconcile";

export function liveLlmIdentity(ai: AiConfig = config.ai): FlowLiveIdentity {
  return {
    promptTemplateVersion: PROMPT_VERSION,
    llmModel: resolveModelName(ai),
  };
}

export class InvalidInstructionError extends Error {
  readonly code = "INVALID_INSTRUCTION";

  constructor(message = "INVALID_INSTRUCTION") {
    super(message);
    this.name = "InvalidInstructionError";
  }
}

export interface FlowEnqueueItem {
  draftId: string;
  campaignId: string;
  recipientId: string;
  isSample: boolean;
}

export interface FlowLiveIdentity {
  promptTemplateVersion: string;
  llmModel: string;
}

export interface FlowClock {
  now: () => Date;
}

export interface FlowDeps {
  db?: PrismaClient;
  identity?: FlowLiveIdentity;
  clock?: FlowClock;
  enqueue?: (jobs: FlowEnqueueItem[]) => Promise<void>;
  dailyLimit?: number;
  dailyUsage?: number;
  getDailyUsage?: (model: string) => Promise<number>;
  sampleSize?: number;
  instructionMaxLength?: number;
  ai?: AiConfig;
}

export type ApproveSamplesResult =
  | { ok: true }
  | { ok: false; code: "BUDGET_WARNING"; needed: number; remaining: number };

async function defaultEnqueue(jobs: FlowEnqueueItem[]): Promise<void> {
  const queue = getGenerateQueue();
  const attempts = 1 + config.ai.maxRetries;
  for (const job of jobs) {
    await ensureGenerateJob(
      {
        draftId: job.draftId,
        data: {
          draftId: job.draftId,
          campaignId: job.campaignId,
          recipientId: job.recipientId,
          isSample: job.isSample,
        },
        attempts,
      },
      {
        getJob: (id) => queue.getJob(id),
        addJob: (name, data, opts) => queue.add(name, data, opts),
      }
    );
  }
}

/**
 * Start sample generation for a campaign.
 * Valid only from DRAFT and only when aiEnabled = true.
 */
export async function startSampling(
  campaignId: string,
  deps: FlowDeps = {}
): Promise<{ ok: boolean; draftIds: string[] }> {
  const db = deps.db ?? (await import("../db/pool")).prisma;
  const liveIdentity: FlowLiveIdentity =
    deps.identity ?? liveLlmIdentity(deps.ai ?? config.ai);
  const sampleSize = deps.sampleSize ?? deps.ai?.sampleSize ?? config.ai.sampleSize;

  let createdJobs: FlowEnqueueItem[] = [];

  await db.$transaction(async (tx) => {
    const campaign = await tx.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} does not exist`);
    }

    if (!campaign.aiEnabled) {
      throw new Error(`Campaign ${campaignId} has AI personalization disabled`);
    }

    if (campaign.status !== "DRAFT") {
      throw new IllegalTransitionError(campaign.status, "SAMPLING");
    }

    const fingerprint = promptFingerprint({
      promptTemplateVersion: liveIdentity.promptTemplateVersion,
      aiInstruction: campaign.aiInstruction ?? "",
      llmModel: liveIdentity.llmModel,
    });

    const recipients = await listRecipients(tx, campaignId);
    const samples = selectSampleRecipients(recipients, sampleSize);

    const sampleDrafts = samples.map((r) => {
      const id = draftId({
        campaignId: campaign.id,
        recipientId: r.id,
        templateHash: campaign.templateHash,
        promptFingerprint: fingerprint,
      });
      return {
        id,
        campaignId: campaign.id,
        recipientId: r.id,
        isSample: true,
        status: "PENDING" as const,
        subject: "",
        body: "",
        promptVersion: fingerprint,
      };
    });

    if (sampleDrafts.length > 0) {
      await tx.generatedDraft.createMany({
        data: sampleDrafts,
        skipDuplicates: true,
      });
    }

    await tx.campaign.update({
      where: { id: campaignId },
      data: {
        promptFingerprint: fingerprint,
        llmModel: liveIdentity.llmModel,
        promptTemplateVersion: liveIdentity.promptTemplateVersion,
      },
    });

    const moved = await transition(tx, campaignId, "DRAFT", "SAMPLING");
    if (!moved) {
      throw new IllegalTransitionError(campaign.status, "SAMPLING");
    }

    createdJobs = sampleDrafts.map((d) => ({
      draftId: d.id,
      campaignId: campaign.id,
      recipientId: d.recipientId,
      isSample: true,
    }));
  });

  // Enqueue jobs AFTER commit.
  const enqueueFn = deps.enqueue ?? defaultEnqueue;
  await enqueueFn(createdJobs);

  return { ok: true, draftIds: createdJobs.map((j) => j.draftId) };
}

/**
 * Regenerate samples with an optionally edited AI instruction.
 * Valid only from SAMPLE_REVIEW.
 */
export async function regenerateSamples(
  campaignId: string,
  options: { aiInstruction?: string | null } = {},
  deps: FlowDeps = {}
): Promise<{ ok: boolean; draftIds: string[] }> {
  const db = deps.db ?? (await import("../db/pool")).prisma;
  const maxLen =
    deps.instructionMaxLength ??
    deps.ai?.instructionMaxLength ??
    config.ai.instructionMaxLength;

  let newInstruction: string | null | undefined;
  if (options.aiInstruction !== undefined) {
    if (options.aiInstruction === null) {
      newInstruction = null;
    } else {
      const trimmed = options.aiInstruction.trim();
      if (trimmed.length > maxLen) {
        throw new InvalidInstructionError(
          `AI instruction exceeds maximum length of ${maxLen} characters`
        );
      }
      newInstruction = trimmed === "" ? null : trimmed;
    }
  }

  const liveIdentity: FlowLiveIdentity =
    deps.identity ?? liveLlmIdentity(deps.ai ?? config.ai);
  const sampleSize = deps.sampleSize ?? deps.ai?.sampleSize ?? config.ai.sampleSize;

  let createdJobs: FlowEnqueueItem[] = [];

  await db.$transaction(async (tx) => {
    const campaign = await tx.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} does not exist`);
    }

    if (campaign.status !== "SAMPLE_REVIEW") {
      throw new IllegalTransitionError(campaign.status, "SAMPLING");
    }

    const effectiveInstruction =
      options.aiInstruction === undefined ? campaign.aiInstruction : newInstruction;

    const fingerprint = promptFingerprint({
      promptTemplateVersion: liveIdentity.promptTemplateVersion,
      aiInstruction: effectiveInstruction ?? "",
      llmModel: liveIdentity.llmModel,
    });

    // Delete existing drafts of the campaign
    await tx.generatedDraft.deleteMany({ where: { campaignId } });

    await tx.campaign.update({
      where: { id: campaignId },
      data: {
        aiInstruction: effectiveInstruction,
        promptFingerprint: fingerprint,
        llmModel: liveIdentity.llmModel,
        promptTemplateVersion: liveIdentity.promptTemplateVersion,
      },
    });

    const recipients = await listRecipients(tx, campaignId);
    const samples = selectSampleRecipients(recipients, sampleSize);

    const sampleDrafts = samples.map((r) => {
      const id = draftId({
        campaignId: campaign.id,
        recipientId: r.id,
        templateHash: campaign.templateHash,
        promptFingerprint: fingerprint,
      });
      return {
        id,
        campaignId: campaign.id,
        recipientId: r.id,
        isSample: true,
        status: "PENDING" as const,
        subject: "",
        body: "",
        promptVersion: fingerprint,
      };
    });

    if (sampleDrafts.length > 0) {
      await tx.generatedDraft.createMany({
        data: sampleDrafts,
        skipDuplicates: true,
      });
    }

    const moved = await transition(tx, campaignId, "SAMPLE_REVIEW", "SAMPLING");
    if (!moved) {
      throw new IllegalTransitionError(campaign.status, "SAMPLING");
    }

    createdJobs = sampleDrafts.map((d) => ({
      draftId: d.id,
      campaignId: campaign.id,
      recipientId: d.recipientId,
      isSample: true,
    }));
  });

  // Enqueue jobs AFTER commit.
  const enqueueFn = deps.enqueue ?? defaultEnqueue;
  await enqueueFn(createdJobs);

  return { ok: true, draftIds: createdJobs.map((j) => j.draftId) };
}

/**
 * Approve samples and fan-out generation to all remaining recipients.
 * Valid only from SAMPLE_REVIEW.
 */
export async function approveSamples(
  campaignId: string,
  options: { acknowledgeBudgetWarning?: boolean } = {},
  deps: FlowDeps = {}
): Promise<ApproveSamplesResult> {
  const db = deps.db ?? (await import("../db/pool")).prisma;

  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) {
    throw new Error(`Campaign ${campaignId} does not exist`);
  }

  if (campaign.status !== "SAMPLE_REVIEW") {
    throw new IllegalTransitionError(campaign.status, "GENERATING");
  }

  if (!campaign.promptFingerprint) {
    throw new Error(`Campaign ${campaignId} has no frozen promptFingerprint`);
  }

  // Load campaign and recipients ONCE
  const recipients = await listRecipients(db, campaignId);
  const existingDrafts = await db.generatedDraft.findMany({
    where: {
      campaignId,
      promptVersion: campaign.promptFingerprint,
    },
    select: { recipientId: true },
  });
  const existingRecipientIds = new Set(existingDrafts.map((d) => d.recipientId));

  // Budget check: needed = recipients with personalization data that do not yet have a draft
  const needed = recipients.filter(
    (r) => r.hasPersonalizationData && !existingRecipientIds.has(r.id)
  ).length;

  const dailyLimit = deps.dailyLimit ?? deps.ai?.dailyRateLimit ?? config.ai.dailyRateLimit;
  if (dailyLimit !== undefined && dailyLimit !== null) {
    if (deps.dailyUsage === undefined && !deps.getDailyUsage) {
      throw new Error(
        "approveSamples needs a daily usage source when a daily limit is configured"
      );
    }
    const dailyUsage =
      deps.dailyUsage ?? (await deps.getDailyUsage!(campaign.llmModel ?? ""));
    const remaining = dailyLimit - dailyUsage;

    if (needed > remaining && !options.acknowledgeBudgetWarning) {
      return { ok: false, code: "BUDGET_WARNING", needed, remaining };
    }
  }

  let createdJobs: FlowEnqueueItem[] = [];

  await db.$transaction(async (tx) => {
    // Precondition check inside transaction
    const current = await tx.campaign.findUnique({ where: { id: campaignId } });
    if (!current || current.status !== "SAMPLE_REVIEW") {
      throw new IllegalTransitionError(current?.status ?? "DRAFT", "GENERATING");
    }

    const ungeneratedRecipients = recipients.filter((r) => !existingRecipientIds.has(r.id));

    const remainingDrafts = ungeneratedRecipients.map((r) => {
      const id = draftId({
        campaignId: campaign.id,
        recipientId: r.id,
        templateHash: campaign.templateHash,
        promptFingerprint: campaign.promptFingerprint!,
      });
      return {
        id,
        campaignId: campaign.id,
        recipientId: r.id,
        isSample: false,
        status: "PENDING" as const,
        subject: "",
        body: "",
        promptVersion: campaign.promptFingerprint!,
      };
    });

    if (remainingDrafts.length > 0) {
      await tx.generatedDraft.createMany({
        data: remainingDrafts,
        skipDuplicates: true,
      });
    }

    await tx.campaign.update({
      where: { id: campaignId },
      data: {
        approvedPromptVersion: campaign.promptFingerprint,
      },
    });

    const moved = await transition(tx, campaignId, "SAMPLE_REVIEW", "GENERATING");
    if (!moved) {
      throw new IllegalTransitionError(current.status, "GENERATING");
    }

    createdJobs = remainingDrafts.map((d) => ({
      draftId: d.id,
      campaignId: campaign.id,
      recipientId: d.recipientId,
      isSample: false,
    }));
  });

  // Enqueue jobs AFTER commit.
  const enqueueFn = deps.enqueue ?? defaultEnqueue;
  await enqueueFn(createdJobs);

  return { ok: true };
}

/**
 * SEAM: In Phase 5a this only transitions the campaign to SCHEDULED.
 * In Phase 6, the body will be replaced with EmailJob creation and scheduling logic.
 *
 * Must go through transition() so two concurrent refreshes call it exactly once.
 */
export async function scheduleCampaign(
  campaignId: string,
  from: "GENERATING" | "EXCEPTION_REVIEW",
  deps: FlowDeps = {}
): Promise<boolean> {
  const db = deps.db ?? (await import("../db/pool")).prisma;
  return transition(db, campaignId, from, "SCHEDULED");
}

/**
 * Inspect campaign and draft database state and progress status when ready.
 * Idempotent. Counts only drafts whose promptVersion equals the campaign's promptFingerprint.
 * Never touches campaigns in PAUSED, CANCELLED, SCHEDULED, SENDING or COMPLETED.
 */
export async function refreshCampaign(
  campaignId: string,
  deps: FlowDeps = {}
): Promise<{ refreshed: boolean; from?: CampaignStatus; to?: CampaignStatus }> {
  const db = deps.db ?? (await import("../db/pool")).prisma;

  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, status: true, promptFingerprint: true },
  });

  if (!campaign) {
    return { refreshed: false };
  }

  // Never touch campaigns in PAUSED, CANCELLED, SCHEDULED, SENDING or COMPLETED
  const nonRefreshableStatuses = new Set<CampaignStatus>([
    "DRAFT",
    "PAUSED",
    "CANCELLED",
    "SCHEDULED",
    "SENDING",
    "COMPLETED",
  ]);

  if (nonRefreshableStatuses.has(campaign.status) || !campaign.promptFingerprint) {
    return { refreshed: false };
  }

  const fingerprint = campaign.promptFingerprint;

  if (campaign.status === "SAMPLING") {
    // SAMPLING -> SAMPLE_REVIEW when every sample draft is READY, FLAGGED or FALLBACK.
    const sampleDrafts = await db.generatedDraft.findMany({
      where: {
        campaignId,
        promptVersion: fingerprint,
        isSample: true,
      },
      select: { status: true },
    });

    if (sampleDrafts.length === 0) {
      return { refreshed: false };
    }

    const allResolved = sampleDrafts.every(
      (d) => d.status === "READY" || d.status === "FLAGGED" || d.status === "FALLBACK"
    );

    if (allResolved) {
      const moved = await transition(db, campaignId, "SAMPLING", "SAMPLE_REVIEW");
      return { refreshed: moved, from: "SAMPLING", to: "SAMPLE_REVIEW" };
    }

    return { refreshed: false };
  }

  if (campaign.status === "GENERATING") {
    // GENERATING: when there is a draft for every recipient and none is PENDING or GENERATING:
    // if any is FLAGGED -> EXCEPTION_REVIEW, otherwise call scheduleCampaign.
    const recipientCount = await db.recipient.count({ where: { campaignId } });
    const draftCount = await db.generatedDraft.count({
      where: { campaignId, promptVersion: fingerprint },
    });

    if (draftCount < recipientCount) {
      return { refreshed: false };
    }

    const pendingOrGenerating = await db.generatedDraft.count({
      where: {
        campaignId,
        promptVersion: fingerprint,
        status: { in: ["PENDING", "GENERATING"] },
      },
    });

    if (pendingOrGenerating > 0) {
      return { refreshed: false };
    }

    const flaggedCount = await db.generatedDraft.count({
      where: {
        campaignId,
        promptVersion: fingerprint,
        status: "FLAGGED",
      },
    });

    if (flaggedCount > 0) {
      const moved = await transition(db, campaignId, "GENERATING", "EXCEPTION_REVIEW");
      return { refreshed: moved, from: "GENERATING", to: "EXCEPTION_REVIEW" };
    } else {
      const moved = await scheduleCampaign(campaignId, "GENERATING", deps);
      return { refreshed: moved, from: "GENERATING", to: "SCHEDULED" };
    }
  }

  if (campaign.status === "EXCEPTION_REVIEW") {
    // EXCEPTION_REVIEW: if no FLAGGED draft remains -> call scheduleCampaign.
    const flaggedCount = await db.generatedDraft.count({
      where: {
        campaignId,
        promptVersion: fingerprint,
        status: "FLAGGED",
      },
    });

    if (flaggedCount === 0) {
      const moved = await scheduleCampaign(campaignId, "EXCEPTION_REVIEW", deps);
      return { refreshed: moved, from: "EXCEPTION_REVIEW", to: "SCHEDULED" };
    }

    return { refreshed: false };
  }

  return { refreshed: false };
}
