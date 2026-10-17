import type { GuardrailFailure } from "./types";

export const BANNED_PHRASES: readonly string[] = [
  "webinar",
  "workshop",
  "event",
  "session",
  "demo",
  "invitation",
  "invite",
  "register",
  "conference",
  "reaching out",
  "reach out",
  "wanted to",
  "writing to",
  "congratulations",
  "congrats",
  "i noticed",
  "i saw",
  "guarantee",
  "guaranteed",
  "revenue",
  "funding",
  "raised",
  "acquisition",
  "layoff",
  "layoffs",
  "hiring",
  "lawsuit",
] as const;

// Sort descending by length so longer phrases match first (e.g. "reaching out" before "reach out")
const BANNED_PATTERN = new RegExp(
  `\\b(?:${BANNED_PHRASES.slice()
    .sort((a, b) => b.length - a.length)
    .map((phrase) => phrase.replace(/\s+/g, "\\s+"))
    .join("|")})\\b`,
  "i"
);

/**
 * BANNED_PHRASE: whole-word or whole-phrase match against BANNED_PHRASES.
 */
export function checkBannedPhrase(intro: string): GuardrailFailure | null {
  const match = intro.match(BANNED_PATTERN);
  if (match) {
    return {
      code: "BANNED_PHRASE",
      detail: `Intro contains banned phrase: "${match[0]}"`,
    };
  }
  return null;
}
