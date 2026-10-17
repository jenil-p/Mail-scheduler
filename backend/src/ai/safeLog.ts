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

// Matches something that looks like an email address: a local part (capped at
// 64 chars, the RFC 5321 limit), an @, a domain part, a dot, and a TLD.
// "@" is excluded from every character class so a bucket-of-addresses string like
// "a@a@a@..." stays linear instead of driving polynomial backtracking.
const EMAIL_PATTERN = /[^\s<>()"',;:@]{1,64}@[^\s<>()"',;:@]+\.[^\s<>()"',;:@]+/g;

/** How much of an error message is kept. Enough to act on, too short to leak. */
export const MAX_LOGGED_MESSAGE_CHARS = 300;

/**
 * Input is truncated before the regex so a huge provider error stays cheap and a
// provider that echoes the request back inside its error message cannot drive the
// regex across a huge input.
 */
export const MAX_INPUT_CHARS = 2000;

/** Replace anything that looks like an email address, then truncate. */
export function redactText(value: string, max = MAX_LOGGED_MESSAGE_CHARS): string {
  const capped =
    value.length > MAX_INPUT_CHARS ? value.slice(0, MAX_INPUT_CHARS) : value;
  const withoutEmails = capped.replace(EMAIL_PATTERN, "[email]");
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
    const errorClass =
      error.name && error.name !== "Error" ? error.name : error.constructor?.name || error.name;
    const parts = [
      `${errorClass}: ${redactText(error.message)}`,
      typeof code === "string" ? `code=${code}` : undefined,
      typeof retryAfterMs === "number" ? `retryAfterMs=${retryAfterMs}` : undefined,
    ].filter((part): part is string => part !== undefined);
    return parts.join(" ");
  }

  return typeof error === "string" ? redactText(error) : "Unknown error";
}
