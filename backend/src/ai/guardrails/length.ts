import type { GuardrailFailure } from "./types";

/**
 * TOO_LONG: intro.length > introMaxChars, or more than 2 sentences
 * (count of [.!?] followed by whitespace or end of text, ignoring a trailing one).
 */
export function checkLength(intro: string, introMaxChars: number): GuardrailFailure | null {
  if (intro.length > introMaxChars) {
    return {
      code: "TOO_LONG",
      detail: `Intro length (${intro.length}) exceeds maximum of ${introMaxChars} characters`,
    };
  }

  const trimmed = intro.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const matches = trimmed.match(/[.!?](?=\s|$)/g);
  let delimiterCount = matches ? matches.length : 0;

  // Ignore a trailing sentence delimiter at the end of the text
  if (/[.!?]$/.test(trimmed) && delimiterCount > 0) {
    delimiterCount -= 1;
  }

  const sentenceCount = delimiterCount + 1;
  if (sentenceCount > 2) {
    return {
      code: "TOO_LONG",
      detail: `Intro has ${sentenceCount} sentences, which exceeds the limit of 2`,
    };
  }

  return null;
}
