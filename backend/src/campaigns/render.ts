/**
 * Pure, deterministic template rendering (spec section 7.4, decision O6).
 *
 * Campaign bodies are plain text: both the template text and every substituted
 * value (CSV fields and the AI-written intro) are HTML-escaped, and newlines
 * become `<br>`. The model's output is therefore only ever plain text and can
 * never inject markup (NFR-3).
 *
 * The `{{ai_intro}}` slot is special: when it has no value (a fallback draft, or
 * a recipient with thin data) the line carrying the slot is removed **and** the
 * blank-line gap it leaves behind is collapsed, so the email never contains a
 * hole where the sentence would have been.
 *
 * Nothing here reads config or the database, and it never throws: a variable the
 * recipient simply has no value for renders as empty text ("failures never drop
 * an email"). Variables that are not valid at all are rejected earlier by
 * `validateTemplate` at submit time, not here at send time (§7.4).
 */

export const AI_SLOT_VARIABLE = "ai_intro";

const PLACEHOLDER_SOURCE = "\\{\\{\\s*([A-Za-z0-9_]+)\\s*\\}\\}";
const PLACEHOLDER_RE = new RegExp(PLACEHOLDER_SOURCE, "g");

/**
 * A line that holds nothing but the AI slot. The trailing newline is consumed with
 * it, so removing the line leaves its surrounding structure intact; the prefix
 * newline is kept (and returned) so line boundaries survive the replacement.
 */
const SLOT_ONLY_LINE_RE = /(^|\n)[ \t]*\{\{\s*ai_intro\s*\}\}[ \t]*\n?/gi;

export type TemplateValues = Record<string, string | undefined>;

export interface TemplateScan {
  /** Distinct placeholder names, in first-appearance order (case as written). */
  variables: string[];
  /** How many times each name appears (lowercased). */
  occurrences: Record<string, number>;
  /** `{{` or `}}` fragments that are not part of a well-formed placeholder. */
  malformed: string[];
}

export function scanTemplate(template: string): TemplateScan {
  const variables: string[] = [];
  const occurrences: Record<string, number> = {};

  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    const key = name.toLowerCase();
    if (!variables.includes(name)) variables.push(name);
    occurrences[key] = (occurrences[key] ?? 0) + 1;
  }

  const leftovers = template.replace(PLACEHOLDER_RE, "");
  const malformed = [...new Set(leftovers.match(/\{\{|\}\}/g) ?? [])];

  return { variables, occurrences, malformed };
}

export function countPlaceholder(template: string, variable: string): number {
  return scanTemplate(template).occurrences[variable.toLowerCase()] ?? 0;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/** Subject lines are plain text, so only whitespace is normalised (no entities). */
export function normalizeSubject(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

function toValueMap(values: TemplateValues): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    map.set(key.toLowerCase(), value);
  }
  return map;
}

function isEmpty(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/**
 * Splice placeholders into the template. Variable names are matched
 * case-insensitively (CSV headers are, per spec section 13) and a variable the
 * recipient has no value for becomes an empty string.
 */
function substitute(
  template: string,
  values: Map<string, string | undefined>,
  transform: (value: string) => string
): string {
  let output = "";
  let cursor = 0;

  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const index = match.index;

    output += transform(template.slice(cursor, index));
    output += transform(values.get(match[1].toLowerCase()) ?? "");
    cursor = index + match[0].length;
  }

  return output + transform(template.slice(cursor));
}

function removeSlotOnlyLines(template: string): { text: string; removed: boolean } {
  let removed = false;

  const text = template.replace(SLOT_ONLY_LINE_RE, (_match, prefix: string) => {
    removed = true;
    return prefix;
  });

  return { text, removed };
}

/**
 * Tidy up the gap the removed line left behind: at most one blank line survives
 * (three newlines would render as a visible hole), and no blank first/last line.
 */
function collapseSlotGap(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * Render the body: escape everything, drop an empty `{{ai_intro}}` line without
 * leaving a gap, and turn newlines into `<br>`.
 */
export function renderBody(template: string, values: TemplateValues): string {
  const map = toValueMap(values);
  const introEmpty = isEmpty(map.get(AI_SLOT_VARIABLE));

  const { text, removed } = introEmpty
    ? removeSlotOnlyLines(template)
    : { text: template, removed: false };

  const escaped = substitute(text, map, escapeHtml);
  const withoutGap = removed ? collapseSlotGap(escaped) : escaped;

  return withoutGap.replace(/\n/g, "<br>");
}

/**
 * Render the subject: plain-text substitution (no HTML escaping — the subject is
 * a mail header, not markup) with newlines flattened so a value cannot inject
 * extra headers.
 */
export function renderSubject(template: string, values: TemplateValues): string {
  return normalizeSubject(substitute(template, toValueMap(values), (value) => value));
}

export interface RenderEmailInput {
  subjectTemplate: string;
  bodyTemplate: string;
  values: TemplateValues;
}

/** Render the final subject and body stored on a draft. */
export function renderEmail({ subjectTemplate, bodyTemplate, values }: RenderEmailInput): {
  subject: string;
  body: string;
} {
  return {
    subject: renderSubject(subjectTemplate, values),
    body: renderBody(bodyTemplate, values),
  };
}
