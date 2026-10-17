import type { GuardrailFailure, GuardrailRecipientData } from "./types";

/**
 * Words allowed to be capitalized mid-sentence even if not in recipient data.
 */
export const ALLOWED_WORDS: ReadonlySet<string> = new Set([
  "I",
  "Hope",
  "Thanks",
]);

/**
 * UNGROUNDED_ENTITY: every capitalized word that is not the first word of a sentence
 * must appear (whole word, case-insensitive) in the recipient fields or in one
 * exported ALLOWED_WORDS constant. Detect capitals case-sensitively.
 */
export function checkUngroundedEntity(
  intro: string,
  recipient: GuardrailRecipientData
): GuardrailFailure | null {
  const groundedWords = new Set<string>();

  for (const field of [recipient.first_name, recipient.company, recipient.role, recipient.note]) {
    if (!field) continue;
    const tokens = field.toLowerCase().match(/[a-z0-9]+/g);
    if (tokens) {
      for (const t of tokens) groundedWords.add(t);
    }
  }

  for (const word of ALLOWED_WORDS) {
    groundedWords.add(word.toLowerCase());
  }

  // Split into sentences using sentence-ending punctuation followed by whitespace or end of string
  const sentences = intro.split(/[.!?]+(?:\s+|$)/);

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length === 0) continue;

    const words = trimmed.split(/\s+/);
    // Word 0 is the first word of this sentence; check only subsequent words (index >= 1)
    for (let i = 1; i < words.length; i++) {
      const raw = words[i];
      // Strip leading/trailing punctuation and possessives (e.g. Corp's -> Corp)
      const clean = raw
        .replace(/^[^\w]+/, "")
        .replace(/['’]s?$/i, "")
        .replace(/[^\w]+$/, "");

      if (clean.length === 0) continue;

      // Detect capitals case-sensitively on the cleaned word
      if (/^[A-Z]/.test(clean)) {
        if (!groundedWords.has(clean.toLowerCase())) {
          return {
            code: "UNGROUNDED_ENTITY",
            detail: `Ungrounded entity: "${clean}"`,
          };
        }
      }
    }
  }

  return null;
}
