import { describe, it, expect } from "vitest";
import {
  CampaignFormState,
  getFormFingerprint,
  isDryRunValidForCurrentForm,
  canCreateCampaign,
  isCsvFileWithinLimit,
  MAX_CSV_SIZE_BYTES,
  MAX_REQUEST_SIZE_BYTES,
  getPayloadByteLength,
  getPayloadSizeErrorMessage,
  validateRequestSize,
} from "./campaignGating";
import { DryRunResponseData } from "@/types/campaigns";

describe("campaignGating", () => {
  const baseForm: CampaignFormState = {
    name: "Summer Sale",
    subjectTemplate: "Hello {{first_name}}",
    bodyTemplate: "Check out {{link}} or unsubscribe {{unsubscribe_link}}",
    linkUrl: "https://example.com",
    unsubscribeUrl: "https://example.com/unsub",
    aiEnabled: true,
    aiInstruction: "Be friendly and polite",
    onUnresolved: "FALLBACK_TO_PLAIN",
    scheduledAt: "2026-11-01T10:00",
    csv: "email,first_name\nalice@example.com,Alice",
  };

  describe("getFormFingerprint & isDryRunValidForCurrentForm", () => {
    it("produces identical fingerprints for identical form states", () => {
      const fp1 = getFormFingerprint(baseForm);
      const fp2 = getFormFingerprint({ ...baseForm });
      expect(fp1).toBe(fp2);
      expect(isDryRunValidForCurrentForm(fp1, baseForm)).toBe(true);
    });

    it("changes fingerprint when any field changes", () => {
      const fieldsToMutate: Array<{ field: keyof CampaignFormState; value: any }> = [
        { field: "name", value: "Different Name" },
        { field: "subjectTemplate", value: "New Subject" },
        { field: "bodyTemplate", value: "New Body" },
        { field: "linkUrl", value: "https://diff.com" },
        { field: "unsubscribeUrl", value: "https://diff.com/unsub" },
        { field: "aiEnabled", value: false },
        { field: "aiInstruction", value: "Be formal and direct" },
        { field: "onUnresolved", value: "HOLD" },
        { field: "scheduledAt", value: "2026-12-01T12:00" },
        { field: "csv", value: "email\nbob@example.com" },
      ];

      const baseFp = getFormFingerprint(baseForm);

      for (const { field, value } of fieldsToMutate) {
        const modifiedForm = { ...baseForm, [field]: value };
        const modifiedFp = getFormFingerprint(modifiedForm);
        expect(modifiedFp).not.toBe(baseFp);
        expect(isDryRunValidForCurrentForm(baseFp, modifiedForm)).toBe(false);
      }
    });

    it("returns false when validatedFingerprint is null", () => {
      expect(isDryRunValidForCurrentForm(null, baseForm)).toBe(false);
    });
  });

  describe("canCreateCampaign", () => {
    const validFp = getFormFingerprint(baseForm);
    const cleanDryRun: DryRunResponseData = {
      errors: [],
      warnings: [],
      rejected: [],
      rejectedCount: 0,
      headerMapping: { email: "email" },
      extraColumns: [],
    };

    it("enables creation only when clean dry run matches current form and not submitting", () => {
      expect(
        canCreateCampaign({
          validatedFingerprint: validFp,
          currentForm: baseForm,
          dryRunResult: cleanDryRun,
          isValidating: false,
          isCreating: false,
        })
      ).toBe(true);
    });

    it("disables creation when dry run has not been run", () => {
      expect(
        canCreateCampaign({
          validatedFingerprint: null,
          currentForm: baseForm,
          dryRunResult: null,
          isValidating: false,
          isCreating: false,
        })
      ).toBe(false);
    });

    it("disables creation when form changed since dry run", () => {
      const modifiedForm = { ...baseForm, name: "Changed" };
      expect(
        canCreateCampaign({
          validatedFingerprint: validFp,
          currentForm: modifiedForm,
          dryRunResult: cleanDryRun,
          isValidating: false,
          isCreating: false,
        })
      ).toBe(false);
    });

    it("disables creation when dry run has blocking errors", () => {
      const errorDryRun: DryRunResponseData = {
        ...cleanDryRun,
        errors: [{ code: "VALIDATION_FAILED", message: "Missing placeholder" }],
      };
      expect(
        canCreateCampaign({
          validatedFingerprint: validFp,
          currentForm: baseForm,
          dryRunResult: errorDryRun,
          isValidating: false,
          isCreating: false,
        })
      ).toBe(false);
    });

    it("disables creation while actively validating or creating", () => {
      expect(
        canCreateCampaign({
          validatedFingerprint: validFp,
          currentForm: baseForm,
          dryRunResult: cleanDryRun,
          isValidating: true,
          isCreating: false,
        })
      ).toBe(false);

      expect(
        canCreateCampaign({
          validatedFingerprint: validFp,
          currentForm: baseForm,
          dryRunResult: cleanDryRun,
          isValidating: false,
          isCreating: true,
        })
      ).toBe(false);
    });
  });

  describe("size check boundaries", () => {
    it("enforces MAX_CSV_SIZE_BYTES (1 MB)", () => {
      expect(isCsvFileWithinLimit(MAX_CSV_SIZE_BYTES)).toBe(true);
      expect(isCsvFileWithinLimit(MAX_CSV_SIZE_BYTES - 1)).toBe(true);
      expect(isCsvFileWithinLimit(MAX_CSV_SIZE_BYTES + 1)).toBe(false);
    });

    it("computes accurate UTF-8 byte length for payload", () => {
      const payload = { test: "hello" };
      const expected = new TextEncoder().encode(JSON.stringify(payload)).length;
      expect(getPayloadByteLength(payload)).toBe(expected);
    });

    it("validates request size boundaries at 1_000_000 bytes", () => {
      // Small payload is valid
      const smallCheck = validateRequestSize({ name: "Small" });
      expect(smallCheck.valid).toBe(true);
      expect(smallCheck.error).toBeNull();

      // Exactly 1_000_000 bytes
      // Construct a payload whose JSON string is exactly 1_000_000 bytes
      // {"data":"..."} has 11 overhead characters
      const exactPadding = "a".repeat(MAX_REQUEST_SIZE_BYTES - 11);
      const exactPayload = { data: exactPadding };
      expect(getPayloadByteLength(exactPayload)).toBe(1_000_000);
      const exactCheck = validateRequestSize(exactPayload);
      expect(exactCheck.valid).toBe(true);
      expect(exactCheck.error).toBeNull();

      // 1_000_001 bytes (exceeds limit by 1 byte)
      const overPadding = "a".repeat(MAX_REQUEST_SIZE_BYTES - 10);
      const overPayload = { data: overPadding };
      expect(getPayloadByteLength(overPayload)).toBe(1_000_001);
      const overCheck = validateRequestSize(overPayload);
      expect(overCheck.valid).toBe(false);
      expect(overCheck.error).toContain("This campaign is too large to send");
      expect(overCheck.error).toContain("1,000 KB");
    });

    it("formats payload size error message with KB estimation", () => {
      const msg = getPayloadSizeErrorMessage(1_250_000);
      expect(msg).toBe(
        "This campaign is too large to send (about 1,250 KB of 1,000 KB). Remove rows or shorten the templates."
      );
    });
  });
});
