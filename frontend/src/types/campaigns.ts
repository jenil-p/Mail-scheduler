// ─── Campaign Lifecycle & Types (Phase 7b) ───

export type CampaignStatus =
  | "DRAFT"
  | "SAMPLING"
  | "SAMPLE_REVIEW"
  | "GENERATING"
  | "EXCEPTION_REVIEW"
  | "SCHEDULED"
  | "SENDING"
  | "PAUSED"
  | "COMPLETED"
  | "CANCELLED";

export type DraftStatus =
  | "PENDING"
  | "GENERATING"
  | "READY"
  | "FLAGGED"
  | "FALLBACK"
  | "APPROVED"
  | "HELD"
  | "QUEUED";

export type ReviewMode = "SAMPLE" | "FULL";
export type OnUnresolved = "FALLBACK_TO_PLAIN" | "HOLD";

export type GuardrailCode =
  | "EMPTY_INTRO"
  | "CONTAINS_NEWLINE"
  | "TOO_LONG"
  | "STARTS_WITH_GREETING"
  | "FORBIDDEN_CONTENT"
  | "UNGROUNDED_NUMBER"
  | "UNGROUNDED_ENTITY"
  | "BANNED_PHRASE"
  | "INJECTION_SUSPECTED"
  | "RENDER_INVALID"
  | string;

export interface GuardrailFailure {
  code: GuardrailCode;
  detail: string;
}

export interface DraftCounts {
  PENDING: number;
  GENERATING: number;
  READY: number;
  FLAGGED: number;
  FALLBACK: number;
  APPROVED: number;
  HELD: number;
  QUEUED: number;
}

export interface SendCounts {
  pending: number;
  rate_limited: number;
  sent: number;
  failed: number;
}

export interface CampaignSummary {
  status: CampaignStatus;
  errorMessage: string | null;
  scheduledAt: string;
  recipientCount: number;
  draftCounts: DraftCounts;
  counts: DraftCounts;
  sendCounts: SendCounts;
}

// ─── Campaign Responses ───

export interface CampaignListItem {
  id: string;
  name: string;
  status: CampaignStatus;
  aiEnabled: boolean;
  scheduledAt: string;
  errorMessage: string | null;
  recipientCount: number;
}

export interface CampaignDetail {
  id: string;
  name: string;
  subjectTemplate: string;
  bodyTemplate: string;
  linkUrl: string;
  unsubscribeUrl: string;
  aiEnabled: boolean;
  aiInstruction: string | null;
  reviewMode: ReviewMode;
  onUnresolved: OnUnresolved;
  scheduledAt: string;
  status: CampaignStatus;
  errorMessage: string | null;
  recipientCount: number;
  draftCounts: DraftCounts;
  counts: DraftCounts;
  sendCounts: SendCounts;
  summary?: CampaignSummary;
}

// ─── Create & Dry Run ───

export interface CreateCampaignPayload {
  name: string;
  subjectTemplate: string;
  bodyTemplate: string;
  linkUrl: string;
  unsubscribeUrl: string;
  aiEnabled: boolean;
  aiInstruction?: string | null;
  reviewMode: ReviewMode;
  onUnresolved: OnUnresolved;
  scheduledAt: string;
  csv: string;
  dryRun?: boolean;
}

export interface TemplateWarning {
  variable: string;
  recipientsMissing: number;
  total: number;
}

export interface RejectedRecipient {
  rowNumber: number;
  code: string;
  detail: string;
}

export interface DryRunResponseData {
  errors: Array<{ code: string; message: string; field?: string }>;
  warnings: TemplateWarning[];
  rejected: RejectedRecipient[];
  rejectedCount: number;
  headerMapping: Record<string, string>;
  extraColumns: string[];
}

export interface CreateCampaignSuccessData {
  campaignId: string;
  status: CampaignStatus;
  recipients: {
    accepted: number;
    rejectedCount: number;
    rejected: RejectedRecipient[];
  };
  warnings: TemplateWarning[];
  headerMapping: Record<string, string>;
}

// ─── Drafts ───

export interface CampaignDraft {
  id: string;
  status: DraftStatus;
  isSample: boolean;
  recipientEmail: string;
  recipientFirstName: string | null;
  aiIntro: string | null;
  subject: string;
  body: string;
  flagReasons: GuardrailFailure[];
  fallbackReason: string | null;
  resolvedBy: string | null;
}

export type ResolveDraftPayload =
  | { type: "approve" }
  | { type: "use_plain" }
  | { type: "edit"; aiIntro: string };

export interface ResolveDraftResponseData {
  applied: boolean;
  status: DraftStatus;
  flagReasons: GuardrailFailure[];
}

export interface BulkResolvePayload {
  type: "approve" | "use_plain";
  codes?: string[];
}

export interface BulkResolveResponseData {
  changed: number;
  skippedHardBlocked: number;
}

export interface ApproveSamplesResponseData {
  status: CampaignStatus;
}

export interface CampaignStatusTransitionData {
  status: CampaignStatus;
}
