/**
 * Campaign template validation (spec FR-3, decisions A1/O6 and the Phase 2 review).
 *
 * Runs at submit time, so a bad template is rejected with a readable message
 * instead of failing once emails are already scheduled. It reports two things:
 * blocking `errors`, and non-blocking `warnings` about variables that some
 * recipients simply have no value for (unless the template supplies a default).
 *
 * Variable names are matched case-insensitively (CSV headers are, per spec
 * section 13). Placeholders may carry a default: `{{company|your company}}`.
 */

import {
  AI_SLOT_VARIABLE,
  DEFAULT_TEXT_MAX_LENGTH,
  countPlaceholder,
  normalizeNewlines,
  scanTemplate,
  type TemplateScan,
  type TemplateValues,
} from "./render";

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
  | "INVALID_URL"
  | "INVALID_DEFAULT"
  | "DEFAULT_ON_AI_SLOT";

export interface TemplateValidationIssue {
  code: TemplateValidationCode;
  field: "subject" | "body" | "linkUrl" | "unsubscribeUrl";
  message: string;
}

/** Non-blocking: the campaign can still be sent, the user is just told. */
export interface TemplateWarning {
  variable: string;
  recipientsMissing: number;
  total: number;
}

export interface TemplateValidationResult {
  errors: TemplateValidationIssue[];
  warnings: TemplateWarning[];
}

export interface TemplateValidationInput {
  subject: string;
  body: string;
  aiEnabled: boolean;
  /** Column names available from the uploaded CSV (recognized columns + extras). */
  csvVariables: readonly string[];
  linkUrl: string;
  unsubscribeUrl: string;
  /**
   * One value map per recipient, as produced by `buildTemplateValues`, used to
   * count how many recipients are missing a value for each variable. Optional:
   * with no recipients there are simply no warnings.
   */
  recipientValues?: readonly TemplateValues[];
}

/**
 * Create path: normalise the templates with this **before saving them and before
 * hashing them**, so the stored template, the hash behind `draftId` and what is
 * rendered all agree.
 */
export function normalizeTemplateText(value: string): string {
  return normalizeNewlines(value);
}

export function isValidHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isEmptyValue(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/** `{{a|b}}`-shaped groups that are not valid placeholders are bad defaults. */
function isDefaultProblem(fragment: string): boolean {
  return fragment.includes("|");
}

function defaultIssueMessage(fragment: string): string {
  return (
    `Invalid default text in "${fragment}": defaults are 1-${DEFAULT_TEXT_MAX_LENGTH} characters ` +
    "and may not contain { } or |"
  );
}

/**
 * Returns every problem found (empty `errors` = valid). Collecting all of them
 * lets the API report the whole list in one response instead of one per attempt.
 */
export function validateTemplate(input: TemplateValidationInput): TemplateValidationResult {
  const errors: TemplateValidationIssue[] = [];
  const warnings: TemplateWarning[] = [];
  const warningsSeen = new Set<string>();

  if (input.subject.trim() === "") {
    errors.push({ code: "EMPTY_SUBJECT", field: "subject", message: "Subject must not be empty" });
  }

  if (input.body.trim() === "") {
    errors.push({ code: "EMPTY_BODY", field: "body", message: "Body must not be empty" });
  }

  const subjectScan = scanTemplate(input.subject);
  const bodyScan = scanTemplate(input.body);

  for (const [field, scan] of [
    ["subject", subjectScan],
    ["body", bodyScan],
  ] as const) {
    for (const fragment of scan.invalid) {
      errors.push(
        isDefaultProblem(fragment)
          ? { code: "INVALID_DEFAULT", field, message: defaultIssueMessage(fragment) }
          : {
              code: "MALFORMED_PLACEHOLDER",
              field,
              message: `Malformed placeholder "{{${fragment}}}" in ${field} — use {{variable}} or {{variable|default text}}`,
            }
      );
    }

    if (scan.malformed.length > 0) {
      errors.push({
        code: "MALFORMED_PLACEHOLDER",
        field,
        message: `Unclosed placeholder in ${field}: ${scan.malformed.join(", ")} — use {{variable}} or {{variable|default text}}`,
      });
    }

    for (const [variable, defaultText] of Object.entries(scan.defaults)) {
      if (defaultText.trim() === "") {
        errors.push({
          code: "INVALID_DEFAULT",
          field,
          message: `Default text for {{${variable}}} in ${field} must not be blank`,
        });
      }
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
    errors.push({
      code: "UNKNOWN_VARIABLE",
      field: "subject",
      message: `Unknown variables in subject: ${unknownSubject.join(", ")} — they are not CSV columns or built-ins`,
    });
  }

  const unknownBody = unknown(bodyScan.variables);
  if (unknownBody.length > 0) {
    errors.push({
      code: "UNKNOWN_VARIABLE",
      field: "body",
      message: `Unknown variables in body: ${unknownBody.join(", ")} — they are not CSV columns or built-ins`,
    });
  }

  if (countPlaceholder(input.subject, AI_SLOT_VARIABLE) > 0) {
    errors.push({
      code: "AI_SLOT_IN_SUBJECT",
      field: "subject",
      message: `{{${AI_SLOT_VARIABLE}}} may only appear in the body, since subjects are not AI-written`,
    });
  }

  const slots = countPlaceholder(input.body, AI_SLOT_VARIABLE);
  if (input.aiEnabled && slots !== 1) {
    errors.push({
      code: "AI_SLOT_COUNT",
      field: "body",
      message:
        slots === 0
          ? `Body must contain exactly one {{${AI_SLOT_VARIABLE}}} when AI personalization is enabled`
          : `Body must contain exactly one {{${AI_SLOT_VARIABLE}}}, found ${slots}`,
    });
  }

  const aiSlotDefaults = [
    ...Object.keys(subjectScan.defaults),
    ...Object.keys(bodyScan.defaults),
  ].filter((variable) => variable === AI_SLOT_VARIABLE);

  if (aiSlotDefaults.length > 0) {
    errors.push({
      code: "DEFAULT_ON_AI_SLOT",
      field: "body",
      message: `{{${AI_SLOT_VARIABLE}}} may not have a default — the fallback is the plain template`,
    });
  }

  if (countPlaceholder(input.body, UNSUBSCRIBE_VARIABLE) === 0) {
    errors.push({
      code: "MISSING_UNSUBSCRIBE_LINK",
      field: "body",
      message: `Body must contain {{${UNSUBSCRIBE_VARIABLE}}}`,
    });
  }

  for (const [field, value] of [
    ["linkUrl", input.linkUrl],
    ["unsubscribeUrl", input.unsubscribeUrl],
  ] as const) {
    if (!isValidHttpUrl(value)) {
      errors.push({ code: "INVALID_URL", field, message: `${field} must be an absolute http(s) URL` });
    }
  }

  warnings.push(...collectMissingValueWarnings([subjectScan, bodyScan], input.recipientValues, warningsSeen));

  return { errors, warnings };
}

/**
 * Warn when a variable is used somewhere without a default and some recipients
 * have no value for it — the email would go out with a gap the user did not ask
 * for. Variables with a default are never reported, and the AI slot is skipped
 * because it is filled per draft.
 */
function collectMissingValueWarnings(
  scans: readonly TemplateScan[],
  recipientValues: readonly TemplateValues[] | undefined,
  seen: Set<string>
): TemplateWarning[] {
  const warnings: TemplateWarning[] = [];
  const total = recipientValues?.length ?? 0;

  if (total === 0) return warnings;

  const needsValue = new Map<string, string>();

  for (const scan of scans) {
    for (const placeholder of scan.placeholders) {
      const key = placeholder.name.toLowerCase();
      if (key === AI_SLOT_VARIABLE) continue;
      if (placeholder.defaultText !== undefined && placeholder.defaultText.trim() !== "") continue;
      if (!needsValue.has(key)) needsValue.set(key, placeholder.name);
    }
  }

  for (const [key, name] of needsValue) {
    if (seen.has(key)) continue;
    seen.add(key);

    const recipientsMissing = (recipientValues as readonly TemplateValues[]).filter((values) =>
      isEmptyValue(values[key])
    ).length;

    if (recipientsMissing > 0) {
      warnings.push({ variable: name, recipientsMissing, total });
    }
  }

  return warnings;
}
