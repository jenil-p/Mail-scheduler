/**
 * Campaign template validation (spec FR-3 and decision A1/O6).
 *
 * Runs at submit time, so a bad template is rejected with a readable message
 * instead of failing once emails are already scheduled. Variable names are
 * matched case-insensitively (CSV headers are, per spec section 13).
 */

import { AI_SLOT_VARIABLE, countPlaceholder, scanTemplate } from "./render";

/** Always available, whatever the CSV contains (spec FR-3). */
export const BUILT_IN_VARIABLES = [
  "first_name",
  "company",
  "role",
  "note",
  "link",
  "unsubscribe_link",
  AI_SLOT_VARIABLE,
] as const;

export const UNSUBSCRIBE_VARIABLE = "unsubscribe_link";

export type TemplateValidationCode =
  | "EMPTY_SUBJECT"
  | "EMPTY_BODY"
  | "MALFORMED_PLACEHOLDER"
  | "UNKNOWN_VARIABLE"
  | "AI_SLOT_COUNT"
  | "AI_SLOT_IN_SUBJECT"
  | "MISSING_UNSUBSCRIBE_LINK"
  | "INVALID_URL";

export interface TemplateValidationIssue {
  code: TemplateValidationCode;
  field: "subject" | "body" | "linkUrl" | "unsubscribeUrl";
  message: string;
}

export interface TemplateValidationInput {
  subject: string;
  body: string;
  aiEnabled: boolean;
  /** Column names available from the uploaded CSV (recognized columns + extras). */
  csvVariables: readonly string[];
  linkUrl: string;
  unsubscribeUrl: string;
}

export function isValidHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Returns every problem found (empty array = valid). Collecting all of them lets
 * the API report the whole list in one response instead of one per attempt.
 */
export function validateTemplate(input: TemplateValidationInput): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];

  if (input.subject.trim() === "") {
    issues.push({ code: "EMPTY_SUBJECT", field: "subject", message: "Subject must not be empty" });
  }

  if (input.body.trim() === "") {
    issues.push({ code: "EMPTY_BODY", field: "body", message: "Body must not be empty" });
  }

  const subjectScan = scanTemplate(input.subject);
  const bodyScan = scanTemplate(input.body);

  for (const [field, scan] of [
    ["subject", subjectScan],
    ["body", bodyScan],
  ] as const) {
    if (scan.malformed.length > 0) {
      issues.push({
        code: "MALFORMED_PLACEHOLDER",
        field,
        message: `Unclosed placeholder in ${field}: ${scan.malformed.join(", ")} (use {{variable_name}})`,
      });
    }
  }

  const allowed = new Set<string>([
    ...BUILT_IN_VARIABLES.map((name) => name.toLowerCase()),
    ...input.csvVariables.map((name) => name.toLowerCase()),
  ]);

  const unknown = (variables: readonly string[]) =>
    variables.filter((name) => !allowed.has(name.toLowerCase()));

  const unknownSubject = unknown(subjectScan.variables);
  if (unknownSubject.length > 0) {
    issues.push({
      code: "UNKNOWN_VARIABLE",
      field: "subject",
      message: `Unknown variables in subject: ${unknownSubject.join(", ")} — they are not CSV columns or built-ins`,
    });
  }

  const unknownBody = unknown(bodyScan.variables);
  if (unknownBody.length > 0) {
    issues.push({
      code: "UNKNOWN_VARIABLE",
      field: "body",
      message: `Unknown variables in body: ${unknownBody.join(", ")} — they are not CSV columns or built-ins`,
    });
  }

  if (countPlaceholder(input.subject, AI_SLOT_VARIABLE) > 0) {
    issues.push({
      code: "AI_SLOT_IN_SUBJECT",
      field: "subject",
      message: `{{${AI_SLOT_VARIABLE}}} may only appear in the body, since subjects are not AI-written`,
    });
  }

  const slots = countPlaceholder(input.body, AI_SLOT_VARIABLE);
  if (input.aiEnabled && slots !== 1) {
    issues.push({
      code: "AI_SLOT_COUNT",
      field: "body",
      message:
        slots === 0
          ? `Body must contain exactly one {{${AI_SLOT_VARIABLE}}} when AI personalization is enabled`
          : `Body must contain exactly one {{${AI_SLOT_VARIABLE}}}, found ${slots}`,
    });
  }

  if (countPlaceholder(input.body, UNSUBSCRIBE_VARIABLE) === 0) {
    issues.push({
      code: "MISSING_UNSUBSCRIBE_LINK",
      field: "body",
      message: `Body must contain {{${UNSUBSCRIBE_VARIABLE}}}`,
    });
  }

  const urls: Array<["linkUrl" | "unsubscribeUrl", string]> = [
    ["linkUrl", input.linkUrl],
    ["unsubscribeUrl", input.unsubscribeUrl],
  ];

  for (const [field, value] of urls) {
    if (!isValidHttpUrl(value)) {
      issues.push({
        code: "INVALID_URL",
        field,
        message: `${field} must be an absolute http(s) URL`,
      });
    }
  }

  return issues;
}
