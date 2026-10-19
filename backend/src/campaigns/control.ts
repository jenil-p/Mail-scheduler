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
    await reconcileFn(campaignId);
  } else if (createdJobs.length > 0) {
    await safelyEnqueueJobs(createdJobs, deps);
  }

  return { ok: true, status: targetStatus };
}

/**
 * Cancel a campaign before it is scheduled or sent.
 * Allowed from: DRAFT, SAMPLING, SAMPLE_REVIEW, GENERATING, EXCEPTION_REVIEW, PAUSED.
 * From SCHEDULED or SENDING: throws CancelNotSupportedYetError.
 */
export async function cancelCampaign(
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

    if (campaign.status === "SCHEDULED" || campaign.status === "SENDING") {
      throw new CancelNotSupportedYetError(
        `Cancelling a ${campaign.status} campaign is not supported yet`
      );
    }

    if (!ALLOWED_CANCEL_STATUSES.includes(campaign.status)) {
      throw new IllegalTransitionError(campaign.status, "CANCELLED");
    }

    const moved = await transition(tx, campaignId, campaign.status, "CANCELLED");
    if (!moved) {
      throw new IllegalTransitionError(campaign.status, "CANCELLED");
    }
  });

  return { ok: true };
}
