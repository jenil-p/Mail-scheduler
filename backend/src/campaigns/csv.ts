/**
 * Recipient CSV parsing and validation (spec FR-1, FR-2, FR-4, section 13).
 *
 * Handles the messy real-world cases the spec calls out: UTF-8 BOM, CRLF line
 * endings, quoted commas, mixed-case headers. Blank lines are skipped, and rows
 * with a missing or extra cell are tolerated (`relax_column_count`) rather than
 * failing the whole upload.
 *
 * Pure and dependency-light on purpose: it takes the raw text plus the limits,
 * and returns either a structured error or the accepted recipients together with
 * a row-numbered report of everything it rejected.
 *
 * `rowNumber` counts CSV records: the header is 1, the first data row is 2.
 * Blank lines are skipped, so it is not always the physical line number.
 */

import { parse } from "csv-parse/sync";
import { RESERVED_VARIABLES } from "./render";

export const EMAIL_COLUMN = "email";

/** Columns with special meaning; every other column lands in `extra` (FR-1). */
export const RECOGNIZED_COLUMNS = ["email", "first_name", "company", "role", "note"] as const;

/**
 * Columns that must not come from a CSV: a stray column must not be able to fill
 * or override the AI slot or the two campaign-level links (see values.ts).
 */
export const RESERVED_COLUMNS = RESERVED_VARIABLES;

/** Same rule as POST /api/schedule so the two paths accept the same addresses. */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** RFC 5321 limit on the length of an email address. */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Normalise a header (or any raw variable source) into a template variable name:
 * trim, lowercase, runs of non-alphanumeric characters become `_`, and leading /
 * trailing `_` are stripped. `"First Name"` and `"first-name"` both become
 * `first_name`, so the column is usable as `{{first_name}}`.
 */
export function normalizeHeaderName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Cap on how many rejections are reported back (the count is always exact). */
export const MAX_REPORTED_REJECTIONS = 100;

export interface ParsedRecipient {
  rowNumber: number;
  email: string;
  firstName?: string;
  company?: string;
  role?: string;
  note?: string;
  extra?: Record<string, string>;
  /** FR-4: at least one of company / role / note is non-empty. */
  hasPersonalizationData: boolean;
}

export type RecipientRejectionCode =
  | "MISSING_EMAIL"
  | "INVALID_EMAIL"
  | "DUPLICATE_EMAIL"
  | "FIELD_TOO_LONG";

export interface RecipientRejection {
  rowNumber: number;
  code: RecipientRejectionCode;
  /** The offending value, truncated — shown back to the uploader only. */
  value?: string;
  detail: string;
}

export type CsvImportErrorCode =
  | "EMPTY_FILE"
  | "MISSING_EMAIL_COLUMN"
  | "MALFORMED_CSV"
  | "RESERVED_COLUMN"
  | "TOO_MANY_RECIPIENTS";

export interface CsvImportOptions {
  /** FR-2, MAX_RECIPIENTS_PER_CAMPAIGN. */
  maxRecipients: number;
  /** FR-2, RECIPIENT_FIELD_MAX_LENGTH (applies to every column except `note`). */
  fieldMaxLength: number;
  /** FR-2, RECIPIENT_NOTE_MAX_LENGTH. */
  noteMaxLength: number;
}

export type CsvImportResult =
  | {
      ok: true;
      recipients: ParsedRecipient[];
      /** Capped at MAX_REPORTED_REJECTIONS; use rejectedCount for the total. */
      rejected: RecipientRejection[];
      rejectedCount: number;
      /** Non-recognized columns, normalised, available as template variables. */
      extraColumns: string[];
      /** How each accepted header was normalised (original -> variable name). */
      headerMapping: Record<string, string>;
      /** Data records seen (accepted + rejected). */
      dataRowCount: number;
    }
  | { ok: false; code: CsvImportErrorCode; message: string };

function truncate(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** FR-4. Exported because the worker and the API both need the same rule. */
export function computeHasPersonalizationData(fields: {
  company?: string;
  role?: string;
  note?: string;
}): boolean {
  return [fields.company, fields.role, fields.note].some(
    (value) => value !== undefined && value.trim() !== ""
  );
}

export function parseRecipientsCsv(input: string | Buffer, options: CsvImportOptions): CsvImportResult {
  const text = typeof input === "string" ? input.replace(/^\uFEFF/, "") : input.toString("utf8").replace(/^\uFEFF/, "");

  if (text.trim() === "") {
    return { ok: false, code: "EMPTY_FILE", message: "The uploaded file is empty" };
  }

  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }) as string[][];
  } catch (error) {
    return {
      ok: false,
      code: "MALFORMED_CSV",
      message: `Could not read the CSV: ${(error as Error).message}`,
    };
  }

  if (records.length === 0) {
    return { ok: false, code: "EMPTY_FILE", message: "The uploaded file is empty" };
  }

  const header = records[0].map((name) => name.trim());
  const headerMapping: Record<string, string> = {};
  const columnIndex = new Map<string, number>();

  header.forEach((original, index) => {
    const key = normalizeHeaderName(original);
    if (key === "") return; // unnamed column: not usable as a variable
    headerMapping[original] = key;
    if (!columnIndex.has(key)) columnIndex.set(key, index); // first column with a name wins
  });

  if (!columnIndex.has(EMAIL_COLUMN)) {
    return {
      ok: false,
      code: "MISSING_EMAIL_COLUMN",
      message: `The CSV needs an "email" column. Found: ${
        header.filter((name) => name !== "").join(", ") || "(no header row)"
      }`,
    };
  }

  const reservedColumns = RESERVED_COLUMNS.filter((name) => columnIndex.has(name));
  if (reservedColumns.length > 0) {
    return {
      ok: false,
      code: "RESERVED_COLUMN",
      message:
        `The following columns are reserved and cannot come from the CSV: ${reservedColumns.map((name) => `"${name}"`).join(", ")} — ` +
        `{{${reservedColumns.join("}}, {{")}}} is filled from the campaign itself. Rename or remove those columns.`,
    };
  }

  const recognized = new Set<string>(RECOGNIZED_COLUMNS);
  const extraColumns: string[] = [];
  for (const key of columnIndex.keys()) {
    if (recognized.has(key) || extraColumns.includes(key)) continue;
    extraColumns.push(key);
  }

  const recipients: ParsedRecipient[] = [];
  const rejected: RecipientRejection[] = [];
  const seenEmails = new Set<string>();
  let rejectedCount = 0;
  let dataRowCount = 0;
  let tooManyRecipients = false;

  const reject = (rejection: RecipientRejection) => {
    rejectedCount += 1;
    if (rejected.length < MAX_REPORTED_REJECTIONS) rejected.push(rejection);
  };

  const cell = (record: string[], column: string): string => {
    const index = columnIndex.get(column);
    if (index === undefined) return "";
    return (record[index] ?? "").trim();
  };

  for (let i = 1; i < records.length; i++) {
    const record = records[i];
    const rowNumber = i + 1;
    dataRowCount += 1;

    const rawEmail = cell(record, EMAIL_COLUMN);

    if (rawEmail === "") {
      reject({ rowNumber, code: "MISSING_EMAIL", detail: "Row has no email address" });
      continue;
    }

    const email = rawEmail.toLowerCase();

    if (email.length > EMAIL_MAX_LENGTH) {
      reject({
        rowNumber,
        code: "INVALID_EMAIL",
        value: truncate(rawEmail),
        detail: `Address is longer than the ${EMAIL_MAX_LENGTH} character limit for an email address`,
      });
      continue;
    }

    if (!EMAIL_REGEX.test(email)) {
      reject({
        rowNumber,
        code: "INVALID_EMAIL",
        value: truncate(rawEmail),
        detail: "Not a valid email address",
      });
      continue;
    }

    const note = cell(record, "note");
    const fields = {
      firstName: cell(record, "first_name"),
      company: cell(record, "company"),
      role: cell(record, "role"),
      note,
    };

    const tooLong: Array<[string, string, number]> = [
      ["first_name", fields.firstName, options.fieldMaxLength],
      ["company", fields.company, options.fieldMaxLength],
      ["role", fields.role, options.fieldMaxLength],
      ["note", note, options.noteMaxLength],
    ];

    const extra: Record<string, string> = {};
    for (const name of extraColumns) {
      const index = columnIndex.get(name);
      const value = index === undefined ? "" : (record[index] ?? "").trim();
      if (value !== "") extra[name] = value;
    }

    for (const [name, value] of Object.entries(extra)) {
      tooLong.push([name, value, options.fieldMaxLength]);
    }

    const overflow = tooLong.find(([, value, max]) => value.length > max);
    if (overflow) {
      const [name, , max] = overflow;
      reject({
        rowNumber,
        code: "FIELD_TOO_LONG",
        value: truncate(email),
        detail: `"${name}" is longer than the ${max} character limit`,
      });
      continue;
    }

    if (seenEmails.has(email)) {
      reject({
        rowNumber,
        code: "DUPLICATE_EMAIL",
        value: truncate(email),
        detail: "Duplicate address — only the first occurrence is kept",
      });
      continue;
    }

    seenEmails.add(email);

    if (seenEmails.size > options.maxRecipients) {
      // The whole import fails once the campaign cannot hold every recipient;
      // keep counting distinct addresses so the message can state the real count.
      tooManyRecipients = true;
      continue;
    }

    recipients.push({
      rowNumber,
      email,
      firstName: fields.firstName || undefined,
      company: fields.company || undefined,
      role: fields.role || undefined,
      note: fields.note || undefined,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
      hasPersonalizationData: computeHasPersonalizationData({
        company: fields.company,
        role: fields.role,
        note: fields.note,
      }),
    });
  }


  if (tooManyRecipients) {
    return {
      ok: false,
      code: "TOO_MANY_RECIPIENTS",
      message:
        `The file has ${seenEmails.size} valid recipients, which is more than the ` +
        `${options.maxRecipients} recipient limit for one campaign. Split it into smaller campaigns.`,
    };
  }

  return {
    ok: true,
    recipients,
    rejected,
    rejectedCount,
    extraColumns,
    headerMapping,
    dataRowCount,
  };
}
