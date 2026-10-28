import { GuardrailCode, GuardrailFailure } from "@/types/campaigns";

export const HARD_BLOCK_CODES: readonly string[] = [
  "FORBIDDEN_CONTENT",
  "INJECTION_SUSPECTED",
  "RENDER_INVALID",
];

/**
 * Maps deterministic guardrail failure codes to plain-language sentences.
 * Unknown codes fall back to displaying the code itself.
 */
export function mapGuardrailCodeToSentence(code: GuardrailCode): string {
  switch (code) {
    case "EMPTY_INTRO":
      return "The generated intro sentence is empty.";
    case "CONTAINS_NEWLINE":
      return "The sentence contains line breaks, which would disrupt email formatting.";
    case "TOO_LONG":
      return "The sentence exceeds the maximum length or contains more than two sentences.";
    case "STARTS_WITH_GREETING":
      return "The sentence begins with an unnecessary greeting (such as Hi or Hello).";
    case "FORBIDDEN_CONTENT":
      return "The sentence contains forbidden content (URLs, email addresses, phone numbers, or markup).";
    case "UNGROUNDED_NUMBER":
      return "The sentence references numbers not present in the recipient's information.";
    case "UNGROUNDED_ENTITY":
      return "The sentence mentions names or organizations not found in the recipient's profile.";
    case "BANNED_PHRASE":
      return "The sentence uses a restricted marketing or outreach cliché.";
    case "INJECTION_SUSPECTED":
      return "Potential prompt injection or override instructions were detected.";
    case "RENDER_INVALID":
      return "The rendered email failed validation (missing placeholders or invalid unsubscribe link).";
    default:
      return code;
  }
}

/**
 * Checks if a draft has any guardrail failures that cannot be approved directly.
 */
export function isDraftHardBlocked(flagReasons?: GuardrailFailure[] | null): boolean {
  return (flagReasons ?? []).some((r) => HARD_BLOCK_CODES.includes(r.code));
}

/**
 * Returns a human-friendly explanation of why a draft cannot be approved.
 */
export function getHardBlockExplanation(flagReasons?: GuardrailFailure[] | null): string | null {
  const blocked = (flagReasons ?? []).filter((r) => HARD_BLOCK_CODES.includes(r.code));
  if (blocked.length === 0) return null;
  const labels = blocked.map((b) => b.code).join(", ");
  return `This draft cannot be approved because it has security-critical flags (${labels}). You must edit the sentence or use the plain email.`;
}

/**
 * Maps API error codes and details to user-friendly error messages.
 */
export function mapApiErrorCodeToMessage(code?: string, details?: any, fallback?: string): string {
  if (!code) return fallback || "An unexpected error occurred. Please try again.";

  switch (code) {
    case "ILLEGAL_STATE":
      return "This action cannot be performed because the campaign is in an incompatible state.";
    case "HARD_BLOCKED": {
      const blockedCodes = details?.blockedCodes?.join(", ");
      return blockedCodes
        ? `Cannot approve draft with hard-blocked codes: ${blockedCodes}. Please edit the sentence or use plain email.`
        : "This draft contains critical guardrail violations and cannot be approved.";
    }
    case "STALE_DRAFT":
      return "This draft was generated with an older prompt version. Please refresh the page.";
    case "CAMPAIGN_NOT_UNDER_REVIEW":
      return "Drafts can only be modified while the campaign is in exception review.";
    case "VALIDATION_FAILED": {
      if (details?.errors && Array.isArray(details.errors) && details.errors.length > 0) {
        return details.errors.map((e: any) => e.message || e.code).join(". ");
      }
      if (details?.issues && Array.isArray(details.issues) && details.issues.length > 0) {
        return details.issues.map((i: any) => `${i.path}: ${i.message}`).join(", ");
      }
      return "Validation failed. Please check the form inputs.";
    }
    case "PAYLOAD_TOO_LARGE":
      return "The uploaded file exceeds the 1 MB size limit. Please upload a smaller file.";
    case "INVALID_JSON":
      return "The server received malformed data.";
    case "CAMPAIGN_NOT_FOUND":
      return "Campaign not found or you do not have permission to view it.";
    case "DRAFT_NOT_FOUND":
      return "The requested draft was not found.";
    case "BUDGET_WARNING": {
      const needed = details?.needed ?? "some";
      const remaining = details?.remaining ?? 0;
      return `Generation quota warning: campaign needs ${needed} generations, but only ${remaining} remain today.`;
    }
    case "IDENTITY_MISMATCH_AFTER_APPROVAL":
      return "The AI model or prompt template version changed after sample approval. Resuming is not supported. Please cancel and create a new campaign.";
    case "SCHEDULE_TOO_SOON":
      return "The scheduled start time is too soon. Please select a time further in the future.";
    case "FULL_REVIEW_NOT_AVAILABLE":
      return "Full review mode is not currently available. Please select Sample review.";
    case "RESERVED_COLUMN":
      return "The CSV contains reserved column names (ai_intro, link, or unsubscribe_link).";
    case "TOO_MANY_RECIPIENTS":
      return "The recipient count exceeds the maximum limit per campaign.";
    case "AI_INSTRUCTION_NOT_ALLOWED":
      return "AI instructions cannot be provided when AI personalization is disabled.";
    case "INVALID_INSTRUCTION":
      return "The AI instruction exceeds the maximum allowed length (500 characters).";
    case "EMPTY_CAMPAIGN":
      return "The campaign does not have any valid recipients.";
    case "INTRO_TOO_LONG":
      return "The edited AI intro exceeds the maximum character limit.";
    case "INTERNAL_ERROR":
      return "A server error occurred. Please try again later.";
    default:
      return fallback || `Error: ${code}`;
  }
}
