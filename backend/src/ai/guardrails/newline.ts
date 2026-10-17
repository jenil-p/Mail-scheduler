import type { GuardrailFailure } from "./types";

/**
 * CONTAINS_NEWLINE: intro contains \r or \n.
 */
export function checkNewline(intro: string): GuardrailFailure | null {
  if (intro.includes("\r") || intro.includes("\n")) {
    return {
      code: "CONTAINS_NEWLINE",
      detail: "Intro contains newline characters (\\r or \\n)",
    };
  }
  return null;
}
