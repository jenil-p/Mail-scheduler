/**
 * Types and interfaces for deterministic AI intro guardrails (Phase 4).
 */

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
  | "RENDER_INVALID";

export interface GuardrailFailure {
  code: GuardrailCode;
  detail: string;
}

export interface GuardrailRecipientData {
  first_name?: string | null;
  company?: string | null;
  role?: string | null;
  note?: string | null;
}

export interface GuardrailCampaignData {
  linkUrl: string;
  unsubscribeUrl: string;
}

export interface GuardrailInput {
  intro: string;
  recipient: GuardrailRecipientData;
  campaign: GuardrailCampaignData;
  renderedSubject: string;
  renderedBody: string;
  introMaxChars: number;
}
