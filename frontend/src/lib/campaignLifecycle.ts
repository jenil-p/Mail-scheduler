import { CampaignStatus, OnUnresolved } from "@/types/campaigns";

export const FINALIZE_LEAD_MINUTES = 2;

export interface LifecycleStep {
  key: CampaignStatus;
  label: string;
  description?: string;
}

export const AI_LIFECYCLE_STEPS: LifecycleStep[] = [
  { key: "DRAFT", label: "Draft" },
  { key: "SAMPLING", label: "Sampling" },
  { key: "SAMPLE_REVIEW", label: "Sample Review" },
  { key: "GENERATING", label: "Generating" },
  { key: "EXCEPTION_REVIEW", label: "Exception Review" },
  { key: "SCHEDULED", label: "Scheduled" },
  { key: "SENDING", label: "Sending" },
  { key: "COMPLETED", label: "Completed" },
];

export const PLAIN_LIFECYCLE_STEPS: LifecycleStep[] = [
  { key: "DRAFT", label: "Draft" },
  { key: "SCHEDULED", label: "Scheduled" },
  { key: "SENDING", label: "Sending" },
  { key: "COMPLETED", label: "Completed" },
];

export interface StatusActions {
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  canReviewSamples: boolean;
  canReviewExceptions: boolean;
  isReadOnly: boolean;
  shouldPoll: boolean;
}

/**
 * Maps a campaign status and AI flag to available user actions and polling needs.
 */
export function getAvailableActionsForStatus(
  status: CampaignStatus,
  aiEnabled: boolean
): StatusActions {
  const isTerminal = status === "COMPLETED" || status === "CANCELLED";

  return {
    canStart: status === "DRAFT",
    canPause:
      status === "SAMPLING" ||
      status === "SAMPLE_REVIEW" ||
      status === "GENERATING" ||
      status === "EXCEPTION_REVIEW",
    canResume: status === "PAUSED",
    canCancel: !isTerminal,
    canReviewSamples: status === "SAMPLE_REVIEW",
    canReviewExceptions: status === "EXCEPTION_REVIEW",
    isReadOnly: isTerminal,
    shouldPoll: !isTerminal,
  };
}

/**
 * Calculates review deadline Date (scheduledAt minus FINALIZE_LEAD_MINUTES).
 */
export function getReviewDeadline(scheduledAt: string): Date {
  const date = new Date(scheduledAt);
  return new Date(date.getTime() - FINALIZE_LEAD_MINUTES * 60 * 1000);
}

/**
 * Returns milliseconds remaining until the review deadline. Negative means deadline has passed.
 */
export function getMsUntilReviewDeadline(scheduledAt: string, nowMs = Date.now()): number {
  const deadline = getReviewDeadline(scheduledAt);
  return deadline.getTime() - nowMs;
}

/**
 * Formats milliseconds remaining into a readable countdown string.
 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "Deadline has passed";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

/**
 * Returns plain-language description of what happens to unresolved drafts at deadline.
 */
export function getUnresolvedPolicyDescription(onUnresolved: OnUnresolved): string {
  switch (onUnresolved) {
    case "FALLBACK_TO_PLAIN":
      return "Any unreviewed drafts will fall back to the plain email template at the review deadline.";
    case "HOLD":
      return "Any unreviewed drafts will be held and will not be sent.";
    default:
      return "";
  }
}

/**
 * Confirmation dialog message for starting a campaign.
 */
export function getStartConfirmMessage(params: {
  aiEnabled: boolean;
  recipientCount: number;
  scheduledAtFormatted: string;
}): string {
  if (params.aiEnabled) {
    return "This will begin sample generation for this campaign. You will be able to review the AI samples before full generation starts.";
  }
  return `This will schedule ${params.recipientCount} email${
    params.recipientCount === 1 ? "" : "s"
  } to be sent at ${params.scheduledAtFormatted}.`;
}

/**
 * Confirmation dialog message for cancelling a campaign.
 */
export const CANCEL_CONFIRM_MESSAGE =
  "Are you sure you want to cancel this campaign? Any unsent emails will not be sent, and cancelling cannot be undone.";
