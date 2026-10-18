/**
 * Campaign state machine (spec section 6.5 and Phase 5a requirements).
 *
 * One canonical table of allowed transitions, enforced by `transition()`.
 * Terminal statuses: COMPLETED, CANCELLED.
 */

import type { CampaignStatus } from "../generated/prisma/client";

export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  "DRAFT",
  "SAMPLING",
  "SAMPLE_REVIEW",
  "GENERATING",
  "EXCEPTION_REVIEW",
  "SCHEDULED",
  "SENDING",
  "COMPLETED",
  "PAUSED",
  "CANCELLED",
] as const;

/**
 * Table of allowed campaign state transitions.
 *
 * Rules:
 * - DRAFT -> SAMPLING, SCHEDULED (SCHEDULED is for campaigns with aiEnabled false), CANCELLED
 * - SAMPLING -> SAMPLE_REVIEW, PAUSED, CANCELLED
 * - SAMPLE_REVIEW -> SAMPLING (regenerate), GENERATING, PAUSED, CANCELLED
 * - GENERATING -> EXCEPTION_REVIEW, SCHEDULED, PAUSED, CANCELLED
 * - EXCEPTION_REVIEW -> SCHEDULED, PAUSED, CANCELLED
 * - SCHEDULED -> SENDING, CANCELLED
 * - SENDING -> COMPLETED, CANCELLED
 * - PAUSED -> SAMPLING, GENERATING, CANCELLED (reachable ONLY from SAMPLING, SAMPLE_REVIEW, GENERATING, EXCEPTION_REVIEW)
 * - CANCELLED is reachable from every non-terminal status
 * - COMPLETED and CANCELLED are terminal
 */
export const ALLOWED_CAMPAIGN_TRANSITIONS: Readonly<
  Record<CampaignStatus, ReadonlySet<CampaignStatus>>
> = {
  DRAFT: new Set<CampaignStatus>(["SAMPLING", "SCHEDULED", "CANCELLED"]),
  SAMPLING: new Set<CampaignStatus>(["SAMPLE_REVIEW", "PAUSED", "CANCELLED"]),
  SAMPLE_REVIEW: new Set<CampaignStatus>(["SAMPLING", "GENERATING", "PAUSED", "CANCELLED"]),
  GENERATING: new Set<CampaignStatus>(["EXCEPTION_REVIEW", "SCHEDULED", "PAUSED", "CANCELLED"]),
  EXCEPTION_REVIEW: new Set<CampaignStatus>(["SCHEDULED", "PAUSED", "CANCELLED"]),
  SCHEDULED: new Set<CampaignStatus>(["SENDING", "CANCELLED"]),
  SENDING: new Set<CampaignStatus>(["COMPLETED", "CANCELLED"]),
  PAUSED: new Set<CampaignStatus>(["SAMPLING", "GENERATING", "CANCELLED"]),
  COMPLETED: new Set<CampaignStatus>(),
  CANCELLED: new Set<CampaignStatus>(),
};

export class IllegalTransitionError extends Error {
  readonly from: CampaignStatus;
  readonly to: CampaignStatus;
  readonly code = "ILLEGAL_TRANSITION";

  constructor(from: CampaignStatus, to: CampaignStatus) {
    super(`Illegal campaign transition from ${from} to ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function isAllowedTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return ALLOWED_CAMPAIGN_TRANSITIONS[from]?.has(to) ?? false;
}

export interface TransitionDb {
  campaign: {
    updateMany: (args: {
      where: { id: string; status: CampaignStatus };
      data: { status: CampaignStatus; updatedAt?: Date };
    }) => Promise<{ count: number }>;
  };
}

/**
 * Execute a campaign status transition using a precondition update.
 *
 * Returns `true` if the status moved (precondition matched and updated),
 * or `false` if the precondition was not met (e.g. concurrent transition).
 *
 * Throws `IllegalTransitionError` when (from, to) is not in the allowed transitions table.
 */
export async function transition(
  db: TransitionDb,
  campaignId: string,
  from: CampaignStatus,
  to: CampaignStatus
): Promise<boolean> {
  if (!isAllowedTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }

  const result = await db.campaign.updateMany({
    where: {
      id: campaignId,
      status: from,
    },
    data: {
      status: to,
    },
  });

  return result.count > 0;
}
