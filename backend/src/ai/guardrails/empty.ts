import type { GuardrailFailure } from "./types";

/**
 * EMPTY_INTRO: intro.trim() is empty.
 */
export function checkEmpty(intro: string): GuardrailFailure | null {
  if (intro.trim() === "") {
    return {
      code: "EMPTY_INTRO",
      detail: "Intro is empty or whitespace only",
    };
  }
  return null;
}
