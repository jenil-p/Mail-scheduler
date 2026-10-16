import { describe, it, expect } from "vitest";
import { computeHasPersonalizationData, parseRecipientsCsv } from "./csv";

const options = { maxRecipients: 500, fieldMaxLength: 200, noteMaxLength: 500 };

const specCsv = [
  "email,first_name,company,role,note",
  "priya@acme.com,Priya,Acme Corp,Head of Ops,met at PyCon",
  "raj@zeta.io,Raj,,,",
].join("\n");

describe("parseRecipientsCsv", () => {
  it("parses the spec example and computes personalization data", () => {
    const result = parseRecipientsCsv(specCsv, options);

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.recipients).toHaveLength(2);
    expect(result.recipients[0]).toMatchObject({
      rowNumber: 2,
      email: "priya@acme.com",
      firstName: "Priya",
      company: "Acme Corp",
      role: "Head of Ops",
      note: "met at PyCon",
      hasPersonalizationData: true,
    });
    expect(result.recipients[1]).toMatchObject({
      rowNumber: 3,
      email: "raj@zeta.io",
      firstName: "Raj",
      hasPersonalizationData: false,
    });
    expect(result.recipients[1].company).toBeUndefined();
    expect(result.rejectedCount).toBe(0);
    expect(result.dataRowCount).toBe(2);
  });

  it("only requires the email column", () => {
    const result = parseRecipientsCsv("email\na@example.com\n", options);

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.recipients).toEqual([
      expect.objectContaining({ email: "a@example.com", hasPersonalizationData: false }),
    ]);
  });

  it("handles a UTF-8 BOM", () => {
    const result = parseRecipientsCsv(`\uFEFFemail,first_name\na@example.com,Ana\n`, options);

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.recipients[0].firstName).toBe("Ana");
  });

  it("handles CRLF line endings", () => {
    const result = parseRecipientsCsv("email,first_name\r\na@example.com,Ana\r\nb@example.com,Bo\r\n", options);

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.recipients.map((r) => r.email)).toEqual(["a@example.com", "b@example.com"]);
    expect(result.recipients[1].firstName).toBe("Bo");
  });

  it("handles quoted values containing commas and newlines", () => {
    const csv = 'email,company,note\na@example.com,"Acme, Inc.","line one\nline two"\n';
    const result = parseRecipientsCsv(csv, options);

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.recipients[0].company).toBe("Acme, Inc.");
    expect(result.recipients[0].note).toBe("line one\nline two");
  });

  it("accepts mixed-case and padded headers", () => {
    const csv = " Email , First_Name , COMPANY \na@example.com,Ana,Acme\n";
    const result = parseRecipientsCsv(csv, options);

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.recipients[0]).toMatchObject({
      email: "a@example.com",
      firstName: "Ana",
      company: "Acme",
      hasPersonalizationData: true,
    });
  });

  it("skips blank lines and tolerates ragged rows", () => {
    const csv = "email,first_name\n\na@example.com,Ana\n\nb@example.com\n";
    const result = parseRecipientsCsv(csv, options);

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.recipients.map((r) => r.email)).toEqual(["a@example.com", "b@example.com"]);
    expect(result.recipients[1].firstName).toBeUndefined();
  });

  it("rejects an empty file", () => {
    expect(parseRecipientsCsv("   \n  ", options)).toMatchObject({ ok: false, code: "EMPTY_FILE" });
  });

  it("rejects a file with no email column and lists what it found", () => {
    const result = parseRecipientsCsv("name,company\nAna,Acme\n", options);

    expect(result).toMatchObject({ ok: false, code: "MISSING_EMAIL_COLUMN" });
    if (!result.ok) {
      expect(result.message).toContain("email");
      expect(result.message).toContain("name");
    }
  });

  it("rejects a file whose header row is missing entirely", () => {
    expect(parseRecipientsCsv("just some text\n", options)).toMatchObject({
      ok: false,
      code: "MISSING_EMAIL_COLUMN",
    });
  });

  it("reports malformed CSV instead of throwing", () => {
    const result = parseRecipientsCsv('email,note\na@example.com,"unterminated\n', options);

    expect(result).toMatchObject({ ok: false, code: "MALFORMED_CSV" });
  });

  it("trims and lowercases addresses, deduplicating case-insensitively", () => {
    const csv = "email\n  A@Example.COM \n a@example.com \nb@example.com\n";
    const result = parseRecipientsCsv(csv, options);

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.recipients.map((r) => r.email)).toEqual(["a@example.com", "b@example.com"]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ rowNumber: 3, code: "DUPLICATE_EMAIL", value: "a@example.com" }),
    ]);
  });

  it("reports invalid and missing addresses with row numbers, keeping the good ones", () => {
    const csv = "email\nnot-an-email\na@example.com\n\nb@example.org\n";
    const result = parseRecipientsCsv(csv, options);

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.recipients.map((r) => r.email)).toEqual(["a@example.com", "b@example.org"]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ rowNumber: 2, code: "INVALID_EMAIL" }),
    ]);
    expect(result.rejectedCount).toBe(1);
    expect(result.dataRowCount).toBe(3);
  });

  it("flags a row whose recognized field exceeds the limit", () => {
    const result = parseRecipientsCsv(
      `email,company\na@example.com,${"x".repeat(201)}\n`,
      options
    );

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.recipients).toHaveLength(0);
    expect(result.rejected[0]).toMatchObject({ rowNumber: 2, code: "FIELD_TOO_LONG" });
    expect(result.rejected[0].detail).toContain("company");
    expect(result.rejected[0].detail).toContain("200");
  });

  it("uses the higher limit for note", () => {
    const result = parseRecipientsCsv(
      `email,note\na@example.com,${"x".repeat(300)}\n`,
      options
    );

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0].note).toHaveLength(300);
  });

  it("keeps unknown columns in extra and returns their names", () => {
    const csv = "email,first_name,city,team\na@example.com,Ana,Berlin,OPS\n";
    const result = parseRecipientsCsv(csv, options);

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.extraColumns).toEqual(["city", "team"]);
    expect(result.recipients[0].extra).toEqual({ city: "Berlin", team: "OPS" });
    expect(result.recipients[0].hasPersonalizationData).toBe(false);
  });

  it("leaves extra undefined when unknown columns are all blank", () => {
    const result = parseRecipientsCsv("email,city\na@example.com,\n", options);

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.recipients[0].extra).toBeUndefined();
    expect(result.extraColumns).toEqual(["city"]);
  });

  it("applies the field limit to extra columns too", () => {
    const result = parseRecipientsCsv(
      `email,city\na@example.com,${"y".repeat(201)}\n`,
      options
    );

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.rejected[0]).toMatchObject({ code: "FIELD_TOO_LONG" });
    expect(result.rejected[0].detail).toContain("city");
  });

  it("enforces the recipient limit and reports the rows it dropped", () => {
    const rows = Array.from({ length: 5 }, (_, i) => `u${i}@example.com`).join("\n");
    const result = parseRecipientsCsv(`email\n${rows}\n`, { ...options, maxRecipients: 2 });

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.recipients.map((r) => r.email)).toEqual(["u0@example.com", "u1@example.com"]);
    expect(result.rejected.filter((r) => r.code === "OVER_RECIPIENT_LIMIT")).toHaveLength(3);
    expect(result.rejectedCount).toBe(3);
  });

  it("caps the reported rejections but keeps the exact count", () => {
    const rows = Array.from({ length: 150 }, (_, i) => `bad-${i}`).join("\n");
    const result = parseRecipientsCsv(`email\n${rows}\n`, options);

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.rejected.length).toBeLessThanOrEqual(100);
    expect(result.rejectedCount).toBe(150);
  });

  it("accepts a Buffer (uploaded files arrive as bytes)", () => {
    const result = parseRecipientsCsv(Buffer.from(specCsv, "utf8"), options);

    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);

    expect(result.recipients).toHaveLength(2);
  });
});

describe("computeHasPersonalizationData", () => {
  it("is true when any of company / role / note is non-empty", () => {
    expect(computeHasPersonalizationData({ company: "Acme" })).toBe(true);
    expect(computeHasPersonalizationData({ role: "Head of Ops" })).toBe(true);
    expect(computeHasPersonalizationData({ note: "met at PyCon" })).toBe(true);
  });

  it("is false when they are empty, blank or missing", () => {
    expect(computeHasPersonalizationData({})).toBe(false);
    expect(computeHasPersonalizationData({ company: "", role: "  ", note: undefined })).toBe(false);
  });

  it("ignores first_name, which is never personalization data", () => {
    expect(computeHasPersonalizationData({ company: undefined, role: undefined, note: undefined })).toBe(
      false
    );
  });
});
