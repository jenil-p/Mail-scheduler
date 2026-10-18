import { describe, expect, it } from "vitest";
import {
  countPersonalizationFields,
  getCompanyLength,
  selectSampleRecipients,
  type SampleRecipientCandidate,
} from "./sampling";

describe("sampling", () => {
  describe("countPersonalizationFields", () => {
    it("counts company, role, and note only, ignoring firstName", () => {
      expect(
        countPersonalizationFields({
          id: "1",
          firstName: "John",
          company: null,
          role: null,
          note: null,
        })
      ).toBe(0);

      expect(
        countPersonalizationFields({
          id: "2",
          firstName: "John",
          company: "Acme",
          role: "Engineer",
          note: "Met at conference",
        })
      ).toBe(3);

      expect(
        countPersonalizationFields({
          id: "3",
          company: "Acme",
          role: null,
          note: undefined,
        })
      ).toBe(1);
    });

    it("treats whitespace-only values as empty", () => {
      expect(
        countPersonalizationFields({
          id: "4",
          company: "   ",
          role: "\t",
          note: "\n",
        })
      ).toBe(0);

      expect(
        countPersonalizationFields({
          id: "5",
          company: " Acme ",
          role: "",
          note: " ",
        })
      ).toBe(1);
    });
  });

  describe("getCompanyLength", () => {
    it("returns trimmed length or 0", () => {
      expect(getCompanyLength({ id: "1", company: "Acme" })).toBe(4);
      expect(getCompanyLength({ id: "2", company: "  Acme Corp  " })).toBe(9);
      expect(getCompanyLength({ id: "3", company: "   " })).toBe(0);
      expect(getCompanyLength({ id: "4", company: null })).toBe(0);
      expect(getCompanyLength({ id: "5" })).toBe(0);
    });
  });

  describe("selectSampleRecipients", () => {
    it("returns empty array when recipients is empty or sampleSize is non-positive", () => {
      expect(selectSampleRecipients([], 5)).toEqual([]);
      expect(selectSampleRecipients([{ id: "1", company: "Acme" }], 0)).toEqual([]);
      expect(selectSampleRecipients([{ id: "1", company: "Acme" }], -1)).toEqual([]);
    });

    it("prefers recipients with most personalization fields up to ceil(sampleSize / 2)", () => {
      const recipients: SampleRecipientCandidate[] = [
        { id: "r1", company: "Acme", role: "Dev", note: "Note" }, // 3 fields
        { id: "r2", company: "Beta", role: "Dev", note: "Note" }, // 3 fields
        { id: "r3", company: "Gamma", role: "Dev", note: "Note" }, // 3 fields
        { id: "r4", company: "Delta", role: "Dev" }, // 2 fields
        { id: "r5", company: "Epsilon" }, // 1 field
      ];

      // sampleSize = 4 -> ceil(4/2) = 2. Top 2 with 3 fields should be r1, r2.
      // (b) thin-data: none exist
      // (c) longest company name: "Epsilon" (len 7) has 1 field. r5 picked!
      // fill: r3 (3 fields) picked!
      const sample = selectSampleRecipients(recipients, 4);
      expect(sample.map((r) => r.id)).toEqual(["r1", "r2", "r5", "r3"]);
    });

    it("includes exactly one thin-data recipient if any exists", () => {
      const recipients: SampleRecipientCandidate[] = [
        { id: "r1", company: "Acme", role: "Dev", note: "Note" }, // 3 fields
        { id: "r2", company: "Beta", role: "Dev", note: "Note" }, // 3 fields
        { id: "r3", company: "Gamma", role: "Dev", note: "Note" }, // 3 fields
        { id: "t2", firstName: "Thin 2" }, // 0 fields (thin)
        { id: "t1", firstName: "Thin 1" }, // 0 fields (thin)
      ];

      // sampleSize = 5:
      // (a) ceil(5/2) = 3: r1, r2, r3 (all 3 fields)
      // (b) one thin data: t1 (tie broken by id: t1 < t2)
      // (c) longest company: "Gamma" (len 5) already in r3
      // fill: none left in data-rich
      const sample = selectSampleRecipients(recipients, 5);
      expect(sample.map((r) => r.id)).toEqual(["r1", "r2", "r3", "t1"]);
      expect(sample.filter((r) => countPersonalizationFields(r) === 0)).toHaveLength(1);
    });

    it("includes recipient with longest company name even if they have fewer personalization fields", () => {
      const recipients: SampleRecipientCandidate[] = [
        { id: "r1", company: "Short", role: "Dev", note: "Note" }, // 3 fields, company len 5
        { id: "r2", company: "Small", role: "Dev", note: "Note" }, // 3 fields, company len 5
        { id: "r3", company: "Tiny", role: "Dev", note: "Note" }, // 3 fields, company len 4
        { id: "r4", company: "International Megacorp Global Logistics", role: null, note: null }, // 1 field, company len 40
        { id: "r5", company: "Medium Company", role: "Designer", note: null }, // 2 fields, company len 14
        { id: "t1", company: null, role: null, note: null }, // 0 fields (thin)
      ];

      // sampleSize = 5:
      // (a) ceil(5/2) = 3: r1, r2, r3 (all 3 fields)
      // (b) thin-data: t1
      // (c) longest company: r4 ("International Megacorp Global Logistics", len 40)
      // total = 5!
      const sample = selectSampleRecipients(recipients, 5);
      expect(sample.map((r) => r.id)).toEqual(["r1", "r2", "r3", "t1", "r4"]);
    });

    it("breaks ties by recipient id in every preference rule", () => {
      const recipients: SampleRecipientCandidate[] = [
        { id: "id_b", company: "Acme", role: "Dev", note: "Note" }, // 3 fields
        { id: "id_a", company: "Acme", role: "Dev", note: "Note" }, // 3 fields
        { id: "id_c", company: "Acme", role: "Dev", note: "Note" }, // 3 fields
      ];

      const sample = selectSampleRecipients(recipients, 2);
      expect(sample.map((r) => r.id)).toEqual(["id_a", "id_b"]);
    });

    it("never includes duplicates even when a recipient satisfies multiple rules", () => {
      const recipients: SampleRecipientCandidate[] = [
        { id: "r1", company: "SuperDuperLongCompany", role: "Dev", note: "Note" }, // 3 fields, longest company
        { id: "r2", company: "A", role: "Dev", note: "Note" }, // 3 fields
        { id: "r3", company: "B", role: "Dev", note: "Note" }, // 3 fields
        { id: "r4", company: "C", role: "Dev" }, // 2 fields
        { id: "t1", company: null }, // thin
      ];

      // sampleSize = 5:
      // (a) r1, r2, r3 (3 fields) - r1 is already selected here!
      // (b) t1 (thin)
      // (c) longest company is r1, but r1 is already in sample. Must not duplicate!
      // fill: r4 (2 fields)
      const sample = selectSampleRecipients(recipients, 5);
      expect(sample.map((r) => r.id)).toEqual(["r1", "r2", "r3", "t1", "r4"]);
      const ids = sample.map((r) => r.id);
      expect(new Set(ids).size).toBe(sample.length);
    });

    it("does not mutate the input array", () => {
      const recipients: SampleRecipientCandidate[] = [
        { id: "r2", company: "Beta" },
        { id: "r1", company: "Alpha" },
      ];
      const copy = [...recipients];

      selectSampleRecipients(recipients, 2);

      expect(recipients).toEqual(copy);
    });

    it("is deterministic across multiple runs", () => {
      const recipients: SampleRecipientCandidate[] = [
        { id: "r1", company: "C1", role: "R1" },
        { id: "r2", company: "C2", role: "R2", note: "N2" },
        { id: "r3", company: "Very Long Company Name 3" },
        { id: "t1" },
        { id: "t2" },
      ];

      const run1 = selectSampleRecipients(recipients, 4);
      const run2 = selectSampleRecipients(recipients, 4);

      expect(run1).toEqual(run2);
    });

    it("handles all thin-data recipients by selecting at most 1 thin recipient", () => {
      const recipients: SampleRecipientCandidate[] = [
        { id: "t3" },
        { id: "t1" },
        { id: "t2" },
      ];

      // (a) 0 data-rich
      // (b) 1 thin (t1, tie-break by id)
      // (c) 0 company
      // fill: 0 remaining data-rich
      const sample = selectSampleRecipients(recipients, 3);
      expect(sample.map((r) => r.id)).toEqual(["t1"]);
    });

    it("handles fewer recipients than sampleSize", () => {
      const recipients: SampleRecipientCandidate[] = [
        { id: "r1", company: "Acme", role: "Dev" },
        { id: "t1" },
      ];

      const sample = selectSampleRecipients(recipients, 5);
      expect(sample.map((r) => r.id)).toEqual(["r1", "t1"]);
    });
  });
});
