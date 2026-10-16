/**
 * Pure, deterministic template rendering (spec section 7.4, decisions O6 and the
 * Phase 2 review).
 *
 * Campaign bodies are plain text: the template text and every substituted value
 * (CSV fields and the AI-written intro) are HTML-escaped, and newlines become
 * `<br>`. The model's output is therefore only ever plain text and can never
 * inject markup (NFR-3). The two campaign links are the single exception: they
 * are rendered as anchors, and only when the value really is an http(s) URL.
 *
 * Placeholder syntax:
 *   {{first_name}}                 value, or empty text when the value is blank
 *   {{company|your company}}       value, or the default text when blank
 *   {{ai_intro}}                   the AI slot: an empty value removes the line
 *
 * Line endings are normalised (`\r\n` and `\r` become `\n`) before anything else,
 * so a template saved from a Windows editor behaves like one saved on Linux.
 *
 * Nothing here reads config or the database, and it never throws: a variable the
 * recipient has no value for renders as empty text (or its default), because
 * "failures never drop an email". Variables that are not valid at all are
 * rejected earlier by `validateTemplate` at submit time.
 */

export const AI_SLOT_VARIABLE = "ai_intro";
export const LINK_VARIABLE = "link";
export const UNSUBSCRIBE_VARIABLE = "unsubscribe_link";

/**
 * Variables a CSV column may never provide: they are the AI slot and the two
 * campaign-level links, so a stray column must not be able to fill or override
 * them (see csv.ts and values.ts).
 */
export const RESERVED_VARIABLES = [
  AI_SLOT_VARIABLE,
  LINK_VARIABLE,
  UNSUBSCRIBE_VARIABLE,
] as const;

export const DEFAULT_TEXT_MAX_LENGTH = 50;

export type TemplateValues = Record<string, string | undefined>;

interface Placeholder {
  name: string;
  /** Default text as written, undefined when the placeholder has none. */
  defaultText?: string;
  raw: string;
}

export interface TemplateScan {
  /** Distinct placeholder names, in first-appearance order (case as written). */
  variables: string[];
  /** How many times each name appears (lowercased). */
  occurrences: Record<string, number>;
  /** Default text per lowercased name (first occurrence wins). */
  defaults: Record<string, string>;
  placeholders: Placeholder[];
  /** `{{...}}` groups that are not well-formed placeholders (bad default text). */
  invalid: string[];
  /** `{{` or `}}` fragments outside any group. */
  malformed: string[];
}

const VARIABLE_NAME = "[A-Za-z0-9_]+";

/** `{{name}}` or `{{name|default text}}` — the default may not contain braces or `|`. */
function placeholderRegex(): RegExp {
  return new RegExp(
    `\\{\\{\\s*(${VARIABLE_NAME})\\s*(?:\\|\\s*([^{}|]{1,${DEFAULT_TEXT_MAX_LENGTH}}?)\\s*)?\\}\\}`,
    "g"
  );
}

/** Any `{{...}}` group, well-formed or not. */
function groupRegex(): RegExp {
  return /\{\{([^{}]*)\}\}/g;
}

/** Create-path helper: `\r\n` and `\r` become `\n`. */
export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/**
 * Classify every placeholder in a template: which variables it uses, their
 * defaults, and which `{{...}}` groups are malformed.
 */
export function scanTemplate(template: string): TemplateScan {
  const text = normalizeNewlines(template);
  const variables: string[] = [];
  const occurrences: Record<string, number> = {};
  const defaults: Record<string, string> = {};
  const placeholders: Placeholder[] = [];

  const covered = new Array<boolean>(text.length).fill(false);
  const groups: Array<{ start: number; end: number; inner: string }> = [];

  for (const match of text.matchAll(placeholderRegex())) {
    const raw = match[0];
    const name = match[1];
    const defaultText = match[2];
    const key = name.toLowerCase();

    placeholders.push({ name, defaultText, raw });
    if (!variables.includes(name)) variables.push(name);
    occurrences[key] = (occurrences[key] ?? 0) + 1;
    if (defaultText !== undefined && defaults[key] === undefined) defaults[key] = defaultText;

    for (let i = match.index; i < match.index + raw.length; i++) covered[i] = true;
  }

  for (const match of text.matchAll(groupRegex())) {
    groups.push({ start: match.index, end: match.index + match[0].length, inner: match[1] });
  }

  const invalid = groups
    .filter((group) => !covered[group.start])
    .map((group) => group.inner.trim());

  let stripped = "";
  let cursor = 0;
  for (const group of groups) {
    stripped += text.slice(cursor, group.start);
    cursor = group.end;
  }
  stripped += text.slice(cursor);

  return {
    variables,
    occurrences,
    defaults,
    placeholders,
    invalid,
    malformed: [...new Set(stripped.match(/\{\{|\}\}/g) ?? [])],
  };
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

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

function isLinkVariable(variable: string): boolean {
  return variable === LINK_VARIABLE || variable === UNSUBSCRIBE_VARIABLE;
}

/**
 * Bodies escape everything, except that the two campaign links become anchors —
 * with the escaped URL as both `href` and text, and only when the value really is
 * an http(s) URL (a default or a mistyped value stays plain escaped text).
 */
function escapeValueForBody(value: string, variable: string): string {
  const trimmed = value.trim();

  if (isLinkVariable(variable) && isHttpUrl(trimmed)) {
    const escaped = escapeHtml(trimmed);
    return `<a href="${escaped}">${escaped}</a>`;
  }

  return escapeHtml(value);
}

/**
 * Splice placeholders into the template. Variable names are matched
 * case-insensitively (CSV headers are, per spec section 13); a blank or missing
 * value falls back to the placeholder's default text, and to empty text when it
 * has none.
 */
function substitute(
  template: string,
  values: Map<string, string | undefined>,
  transform: (value: string, variable: string) => string
): string {
  let output = "";
  let cursor = 0;

  for (const match of template.matchAll(placeholderRegex())) {
    const index = match.index;
    const variable = match[1].toLowerCase();
    const raw = values.get(variable);
    const fallback = match[2]?.trim();

    output += transform(template.slice(cursor, index), "");
    output += transform(isEmpty(raw) ? fallback ?? "" : (raw as string), variable);
    cursor = index + match[0].length;
  }

  return output + transform(template.slice(cursor), "");
}

/**
 * A line that holds nothing but the AI slot. The trailing newline is consumed with
 * it, so removing the line leaves its surrounding structure intact; the prefix
 * newline is kept (and returned) so line boundaries survive the replacement.
 */
const SLOT_ONLY_LINE_RE = /(^|\n)[ \t]*\{\{\s*ai_intro\s*\}\}[ \t]*\n?/gi;

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
 * Render the body: normalise line endings, escape everything, drop an empty
 * `{{ai_intro}}` line without leaving a gap, and turn newlines into `<br>`.
 */
export function renderBody(template: string, values: TemplateValues): string {
  const text = normalizeNewlines(template);
  const map = toValueMap(values);
  const introEmpty = isEmpty(map.get(AI_SLOT_VARIABLE));

  const { text: prepared, removed } = introEmpty
    ? removeSlotOnlyLines(text)
    : { text, removed: false };

  const escaped = substitute(prepared, map, escapeValueForBody);
  const withoutGap = removed ? collapseSlotGap(escaped) : escaped;

  return withoutGap.replace(/\n/g, "<br>");
}

/**
 * Render the subject: plain-text substitution (no HTML escaping — the subject is
 * a mail header, not markup) with newlines flattened so a value cannot inject
 * extra headers. Links stay plain text here.
 */
export function renderSubject(template: string, values: TemplateValues): string {
  const text = normalizeNewlines(template);

  return normalizeSubject(substitute(text, toValueMap(values), (value) => value));
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
