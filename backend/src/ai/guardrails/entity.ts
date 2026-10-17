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
 * Normalize text using NFD and remove combining marks (\p{M}) for accent-insensitive comparison.
 */
function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * UNGROUNDED_ENTITY: every capitalized word that is not the first word of a sentence
 * must appear (whole word, case-insensitive, Unicode-aware) in the recipient fields
 * or in one exported ALLOWED_WORDS constant.
 */
export function checkUngroundedEntity(
  intro: string,
  recipient: GuardrailRecipientData
): GuardrailFailure | null {
  const groundedWords = new Set<string>();

  for (const field of [recipient.first_name, recipient.company, recipient.role, recipient.note]) {
    if (!field) continue;
    const tokens = field.match(/[\p{L}\p{N}]+/gu);
    if (tokens) {
      for (const t of tokens) {
        groundedWords.add(normalizeText(t).toLowerCase());
      }
    }
    const normalizedTokens = normalizeText(field).match(/[\p{L}\p{N}]+/gu);
    if (normalizedTokens) {
      for (const t of normalizedTokens) {
        groundedWords.add(t.toLowerCase());
      }
    }
  }

  for (const word of ALLOWED_WORDS) {
    groundedWords.add(normalizeText(word).toLowerCase());
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
      // Strip surrounding punctuation using \p{L}\p{N} classes and possessives
      const clean = raw
        .replace(/^[^\p{L}\p{N}]+/u, "")
        .replace(/[^\p{L}\p{N}]+$/u, "")
        .replace(/['’]s?$/iu, "")
        .replace(/[^\p{L}\p{N}]+$/u, "");

      if (clean.length === 0) continue;

      // Detect capitals with /^\p{Lu}/u
      if (/^\p{Lu}/u.test(clean)) {
        const normalized = normalizeText(clean).toLowerCase();
        if (!groundedWords.has(normalized)) {
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

