import type { GuardrailFailure } from "./types";

const URL_PATTERN = /https?:\/\/|www\./i;
const EMAIL_PATTERN = /[^\s@]{1,64}@[^\s@]+\.[^\s@]+/;
const PHONE_PATTERN = /(?:\d[\s().-]*){6}\d/;
const MARKUP_PATTERN = /[<>{}`]/;

/**
 * FORBIDDEN_CONTENT: a URL (https?:// or www.), an email-shaped token,
 * a phone-like run of 7+ digits (spaces, dashes, dots, parentheses allowed between digits),
 * markup or template characters (< > ` { }), or a markdown link "](".
 */
export function checkForbidden(intro: string): GuardrailFailure | null {
  if (URL_PATTERN.test(intro)) {
    return {
      code: "FORBIDDEN_CONTENT",
      detail: "Intro contains a URL",
    };
  }

  if (EMAIL_PATTERN.test(intro)) {
    return {
      code: "FORBIDDEN_CONTENT",
      detail: "Intro contains an email address",
    };
  }

  if (PHONE_PATTERN.test(intro)) {
    return {
      code: "FORBIDDEN_CONTENT",
      detail: "Intro contains a phone-like number sequence (7+ digits)",
    };
  }

  if (MARKUP_PATTERN.test(intro)) {
    return {
      code: "FORBIDDEN_CONTENT",
      detail: "Intro contains markup or template characters (<, >, `, {, })",
    };
  }

  if (intro.includes("](")) {
    return {
      code: "FORBIDDEN_CONTENT",
      detail: "Intro contains a markdown link (]( pattern)",
    };
  }

  return null;
}
