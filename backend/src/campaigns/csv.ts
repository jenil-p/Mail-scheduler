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

export const EMAIL_COLUMN = "email";

/** Columns with special meaning; every other column lands in `extra` (FR-1). */
export const RECOGNIZED_COLUMNS = ["email", "first_name", "company", "role", "note"] as const;

/** Same rule as POST /api/schedule so the two paths accept the same addresses. */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  | "FIELD_TOO_LONG"
  | "OVER_RECIPIENT_LIMIT";

export interface RecipientRejection {
  rowNumber: number;
  code: RecipientRejectionCode;
  /** The offending value, truncated — shown back to the uploader only. */
  value?: string;
  detail: string;
}

export type CsvImportErrorCode = "EMPTY_FILE" | "MISSING_EMAIL_COLUMN" | "MALFORMED_CSV";

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
      /** Non-recognized column names, available as template variables. */
      extraColumns: string[];
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
  const columnIndex = new Map<string, number>();

  header.forEach((name, index) => {
    const key = name.toLowerCase();
    if (key !== "" && !columnIndex.has(key)) columnIndex.set(key, index);
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

  const recognized = new Set<string>(RECOGNIZED_COLUMNS);
  const extraColumns: string[] = [];
  for (const name of header) {
    const key = name.toLowerCase();
    if (key === "" || recognized.has(key) || extraColumns.some((c) => c.toLowerCase() === key)) continue;
    extraColumns.push(name);
  }

  const recipients: ParsedRecipient[] = [];
  const rejected: RecipientRejection[] = [];
  const seenEmails = new Set<string>();
  let rejectedCount = 0;
  let dataRowCount = 0;

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
      const index = columnIndex.get(name.toLowerCase());
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

    if (recipients.length >= options.maxRecipients) {
      reject({
        rowNumber,
        code: "OVER_RECIPIENT_LIMIT",
        value: truncate(email),
        detail: `Campaign limit of ${options.maxRecipients} recipients reached`,
      });
      continue;
    }

    seenEmails.add(email);

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


  return {
    ok: true,
    recipients,
    rejected,
    rejectedCount,
    extraColumns,
    dataRowCount,
  };
}
