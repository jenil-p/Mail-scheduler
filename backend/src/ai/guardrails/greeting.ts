import type { GuardrailFailure } from "./types";

const GREETING_PATTERN = /^\s*(hi|hello|hey|dear|greetings|good\s+(morning|afternoon|evening))\b/i;

/**
 * STARTS_WITH_GREETING: ^\s*(hi|hello|hey|dear|greetings|good (morning|afternoon|evening))\b
 */
export function checkGreeting(intro: string): GuardrailFailure | null {
  const match = intro.match(GREETING_PATTERN);
  if (match) {
    return {
      code: "STARTS_WITH_GREETING",
      detail: `Intro starts with a greeting ("${match[1]}")`,
    };
  }
  return null;
}
