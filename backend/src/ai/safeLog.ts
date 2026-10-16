/**
 * Log redaction for the AI feature (NFR-4).
 *
 * The rule is simple and enforced here rather than at each call site: logs carry
 * **ids and error codes**, never recipient emails, never free-text fields and
 * never prompt text. Provider errors are the risky ones — a provider can echo
 * request content back inside its error message — so anything from an error is
 * put through `redactText` before it is logged.
 *
 * `describeDraft` and friends deliberately take ids only, so a log line for a
 * draft cannot accidentally include the recipient it belongs to.
 */

// Deliberately excludes the punctuation that separates list items, so a log line
// with several addresses is redacted as several addresses rather than one blob.
const EMAIL_PATTERN = /[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[^\s<>()"',;:]+/g;

/** How much of an error message is kept. Enough to act on, too short to leak. */
export const MAX_LOGGED_MESSAGE_CHARS = 300;

/** Replace anything that looks like an email address, then truncate. */
export function redactText(value: string, max = MAX_LOGGED_MESSAGE_CHARS): string {
  const withoutEmails = value.replace(EMAIL_PATTERN, "[email]");
  return withoutEmails.length > max ? `${withoutEmails.slice(0, max)}…` : withoutEmails;
}

/**
 * A one-line, safe description of a thrown value for logs.
 *
 * `LlmError` subclasses log their code (and the retry delay when there is one)
 * because that is what an operator needs; everything else logs its name and a
 * redacted message, and a non-Error value is never stringified blindly.
 */
export function safeErrorLog(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
    const parts = [
      `${error.name}: ${redactText(error.message)}`,
      typeof code === "string" ? `code=${code}` : undefined,
      typeof retryAfterMs === "number" ? `retryAfterMs=${retryAfterMs}` : undefined,
    ].filter((part): part is string => part !== undefined);
    return parts.join(" ");
  }

  return typeof error === "string" ? redactText(error) : "Unknown error";
}
