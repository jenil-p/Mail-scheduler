/**
 * Campaign control operations (Phase 5b): pause, resume, cancel.
 *
 * Conventions:
 * - Injected deps for testability.
 * - Transactions where state and rows change together.
 * - Status-precondition updates (using transition()).
 */

import type { PrismaClient, CampaignStatus } from "../generated/prisma/client";
import type { AiConfig } from "../config/ai";
import { config } from "../config";
import { promptFingerprint } from "../ai/identity";
import {
  transition,
  IllegalTransitionError,
} from "./stateMachine";
import {
  liveLlmIdentity,
  createSampleDrafts,
  safelyEnqueueJobs,
  type FlowLiveIdentity,
  type FlowEnqueueItem,
} from "./flow";
import { reconcileGeneration } from "./reconcile";

export class CancelNotSupportedYetError extends Error {
  readonly code = "CANCEL_NOT_SUPPORTED_YET";

  constructor(message = "Cancelling a SCHEDULED or SENDING campaign is not supported yet") {
    super(message);
    this.name = "CancelNotSupportedYetError";
  }
}

export class IdentityMismatchError extends Error {
  readonly code = "IDENTITY_MISMATCH_AFTER_APPROVAL";

  constructor(
    message = "Campaign LLM identity has changed after sample approval; campaign cannot be resumed"
  ) {
    super(message);
    this.name = "IdentityMismatchError";
  }
}

export interface ControlDeps {
  db?: PrismaClient;
  ai?: AiConfig;
  identity?: FlowLiveIdentity;
  reconcile?: (campaignId: string) => Promise<unknown>;
  enqueue?: (jobs: FlowEnqueueItem[]) => Promise<void>;
  sampleSize?: number;
  chunkSize?: number;
  getJob?: (
    jobId: string
  ) => Promise<{ getState: () => Promise<string>; remove: () => Promise<void> } | null | undefined>;
  logger?: {
    error: (message: string) => void;
    info?: (message: string) => void;
  };
}

export const ALLOWED_PAUSE_STATUSES: readonly CampaignStatus[] = [
  "SAMPLING",
  "SAMPLE_REVIEW",
  "GENERATING",
  "EXCEPTION_REVIEW",
] as const;

export const ALLOWED_CANCEL_STATUSES: readonly CampaignStatus[] = [
  "DRAFT",
  "SAMPLING",
  "SAMPLE_REVIEW",
  "GENERATING",
  "EXCEPTION_REVIEW",
  "PAUSED",
  "SCHEDULED",
  "SENDING",
] as const;

/**
 * Pause an active campaign during generation or review.
 * Allowed from: SAMPLING, SAMPLE_REVIEW, GENERATING, EXCEPTION_REVIEW.
 * Sets errorMessage to "Paused by the user."
 */
export async function pauseCampaign(
  campaignId: string,
  deps: ControlDeps = {}
): Promise<{ ok: boolean }> {
  const db = deps.db ?? (await import("../db/pool")).prisma;

  await db.$transaction(async (tx) => {
    const campaign = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true },
    });
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} does not exist`);
    }

    if (!ALLOWED_PAUSE_STATUSES.includes(campaign.status)) {
      throw new IllegalTransitionError(campaign.status, "PAUSED");
    }

    const moved = await transition(tx, campaignId, campaign.status, "PAUSED");
    if (!moved) {
      throw new IllegalTransitionError(campaign.status, "PAUSED");
    }

    await tx.campaign.update({
      where: { id: campaignId },
      data: { errorMessage: "Paused by the user." },
    });
  });

  return { ok: true };
}

/**
 * Resume a PAUSED campaign.
 * Valid only from PAUSED.
 *
 * Identity matching:
 * - Matching identity:
 *     target is SAMPLING if approvedPromptVersion is null, else GENERATING.
 *     Transition + clear errorMessage in one transaction.
 *     After commit: reconcileGeneration(campaignId).
 * - Differing identity with approvedPromptVersion === null:
 *     re-freeze identity, recompute promptFingerprint, delete drafts,
 *     create fresh sample drafts, move PAUSED -> SAMPLING in one transaction.
 *     After commit: safelyEnqueueJobs.
 * - Differing identity with approvedPromptVersion !== null:
 *     throw IdentityMismatchError (code IDENTITY_MISMATCH_AFTER_APPROVAL) and change nothing.
 */
export async function resumeCampaign(
  campaignId: string,
  deps: ControlDeps = {}
): Promise<{ ok: boolean; status: "SAMPLING" | "GENERATING" }> {
  const db = deps.db ?? (await import("../db/pool")).prisma;
  const liveIdentity: FlowLiveIdentity =
    deps.identity ?? liveLlmIdentity(deps.ai ?? config.ai);
  const sampleSize = deps.sampleSize ?? deps.ai?.sampleSize ?? config.ai.sampleSize;

  let createdJobs: FlowEnqueueItem[] = [];
  let targetStatus: "SAMPLING" | "GENERATING" = "SAMPLING";
  let shouldReconcile = false;

  await db.$transaction(async (tx) => {
    const campaign = await tx.campaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} does not exist`);
    }

    if (campaign.status !== "PAUSED") {
      throw new IllegalTransitionError(
        campaign.status,
        campaign.approvedPromptVersion === null ? "SAMPLING" : "GENERATING"
      );
    }

    const identityMatches =
      campaign.promptTemplateVersion === liveIdentity.promptTemplateVersion &&
      campaign.llmModel === liveIdentity.llmModel;

    if (identityMatches) {
      targetStatus = campaign.approvedPromptVersion === null ? "SAMPLING" : "GENERATING";

      const moved = await transition(tx, campaignId, "PAUSED", targetStatus);
      if (!moved) {
        throw new IllegalTransitionError(campaign.status, targetStatus);
      }

      await tx.campaign.update({
        where: { id: campaignId },
        data: { errorMessage: null },
      });

      shouldReconcile = true;
    } else {
      if (campaign.approvedPromptVersion !== null) {
        throw new IdentityMismatchError();
      }

      targetStatus = "SAMPLING";
      const fingerprint = promptFingerprint({
        promptTemplateVersion: liveIdentity.promptTemplateVersion,
        aiInstruction: campaign.aiInstruction ?? "",
        llmModel: liveIdentity.llmModel,
      });

      await tx.generatedDraft.deleteMany({
        where: { campaignId },
      });

      await tx.campaign.update({
        where: { id: campaignId },
        data: {
          promptFingerprint: fingerprint,
          llmModel: liveIdentity.llmModel,
          promptTemplateVersion: liveIdentity.promptTemplateVersion,
          errorMessage: null,
        },
      });

      createdJobs = await createSampleDrafts(
        tx,
        campaign,
        fingerprint,
        sampleSize
      );

      const moved = await transition(tx, campaignId, "PAUSED", "SAMPLING");
      if (!moved) {
        throw new IllegalTransitionError(campaign.status, "SAMPLING");
      }
    }
  });

  if (shouldReconcile) {
    const reconcileFn = deps.reconcile ?? reconcileGeneration;
    try {
      await reconcileFn(campaignId);
    } catch (err: unknown) {
      const errClass = (err as Error)?.constructor?.name || (err as Error)?.name || "Error";
      const logger = deps.logger ?? console;
      logger.error(`[Control] reconcile failed: ${errClass}`);
    }
  } else if (createdJobs.length > 0) {
    await safelyEnqueueJobs(createdJobs, deps);
  }

  return { ok: true, status: targetStatus };
}

/**
 * Cancel a campaign (spec Phase 6b).
 * Allowed from: DRAFT, SAMPLING, SAMPLE_REVIEW, GENERATING, EXCEPTION_REVIEW, PAUSED, SCHEDULED, SENDING.
 *
 * In this order:
 * (a) transition the campaign to CANCELLED;
 * (b) in chunks of 50: find the campaign's EmailJobs with status pending or rate_limited,
 *     delete those rows (the draft's emailJobId becomes null through SetNull) and set the draft
 *     status to HELD; never touch sent or failed rows;
 * (c) best-effort remove their jobs from the send queue (getJob, remove unless the job is active),
 *     logging only the error class on failure.
 */
export async function cancelCampaign(
  campaignId: string,
  deps: ControlDeps = {}
): Promise<{ ok: boolean }> {
  const db = deps.db ?? (await import("../db/pool")).prisma;
  const logger = deps.logger ?? console;
  const chunkSize = deps.chunkSize ?? 50;

  // (a) Transition campaign to CANCELLED
  await db.$transaction(async (tx) => {
    const campaign = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true },
    });
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} does not exist`);
    }

    if (!ALLOWED_CANCEL_STATUSES.includes(campaign.status)) {
      throw new IllegalTransitionError(campaign.status, "CANCELLED");
    }

    const moved = await transition(tx, campaignId, campaign.status, "CANCELLED");
    if (!moved) {
      throw new IllegalTransitionError(campaign.status, "CANCELLED");
    }
  });

  // (b) In chunks of 50: find pending or rate_limited EmailJobs, delete them and set draft status to HELD
  const deletedJobIds: string[] = [];

  while (true) {
    const jobs = await db.emailJob.findMany({
      where: {
        generatedDraft: {
          campaignId,
        },
        status: { in: ["pending", "rate_limited"] },
      },
      take: chunkSize,
      select: {
        id: true,
        generatedDraft: {
          select: { id: true },
        },
      },
    });

    if (jobs.length === 0) {
      break;
    }

    const jobIds = jobs.map((j) => j.id);
    const draftIds = jobs
      .map((j) => j.generatedDraft?.id)
      .filter((id): id is string => Boolean(id));

    await db.$transaction(async (tx) => {
      if (draftIds.length > 0) {
        await tx.generatedDraft.updateMany({
          where: { id: { in: draftIds } },
          data: { status: "HELD" },
        });
      }

      await tx.emailJob.deleteMany({
        where: { id: { in: jobIds } },
      });
    });

    deletedJobIds.push(...jobIds);
  }

  // (c) Best-effort remove from send queue (getJob, remove unless the job is active)
  if (deletedJobIds.length > 0) {
    const getJob =
      deps.getJob ??
      (async (id: string) => {
        const { emailQueue } = await import("../queue/queue");
        return emailQueue.getJob(id);
      });

    for (const jobId of deletedJobIds) {
      try {
        const job = await getJob(jobId);
        if (job) {
          const state = await job.getState();
          if (state !== "active") {
            await job.remove();
          }
        }
      } catch (err: unknown) {
        const errClass = (err as Error)?.constructor?.name || (err as Error)?.name || "Error";
        logger.error(`[Control] queue remove failed: ${errClass}`);
      }
    }
  }

  return { ok: true };
}
