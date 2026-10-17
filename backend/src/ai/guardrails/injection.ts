import type { GuardrailFailure } from "./types";

const BASE_INJECTION_PARTS = [
  "\\bignore\\s+(?:all\\s+)?(?:previous|prior|above)\\b",
  "\\bdisregard\\b",
  "\\bsystem\\s+prompt\\b",
  "<\\/?recipient_data>",
  "\\bassistant\\s*:",
];

export const INPUT_INJECTION_PATTERN = new RegExp(
  BASE_INJECTION_PARTS.join("|"),
  "i"
);

export const OUTPUT_INJECTION_PATTERN = new RegExp(
  [...BASE_INJECTION_PARTS, "\\bas\\s+an\\s+ai\\b"].join("|"),
  "i"
);

/** Kept for backward compatibility with checkInjection / isInjectionSuspected. */
export const INJECTION_PATTERN = OUTPUT_INJECTION_PATTERN;

/**
 * Returns true if text matches output prompt injection pattern.
 */
export function isInjectionSuspected(text: string): boolean {
  return OUTPUT_INJECTION_PATTERN.test(text);
}

/**
 * INJECTION_SUSPECTED: the intro matches any prompt injection pattern.
 */
export function checkInjection(text: string): GuardrailFailure | null {
  const match = text.match(OUTPUT_INJECTION_PATTERN);
  if (match) {
    return {
      code: "INJECTION_SUSPECTED",
      detail: `Suspected prompt injection pattern: "${match[0]}"`,
    };
  }
  return null;
}

/**
 * Check if any recipient field matches the injection patterns.
 * Used by generateWorker before model calls (FR-4 / review fix-up).
 */
export function recipientHasInjection(recipient: {
  firstName?: string | null;
  company?: string | null;
  role?: string | null;
  note?: string | null;
  first_name?: string | null;
}): boolean {
  const fields = [
    recipient.firstName ?? recipient.first_name,
    recipient.company,
    recipient.role,
    recipient.note,
  ];

  return fields.some((field) => Boolean(field && INPUT_INJECTION_PATTERN.test(field)));
}

