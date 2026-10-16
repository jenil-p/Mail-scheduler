import { describe, expect, it } from "vitest";
import {
  CampaignPromptIdentityMissingError,
  campaignPromptIdentity,
  DRAFT_ID_LENGTH,
  draftId,
  promptFingerprint,
  PROMPT_FINGERPRINT_LENGTH,
} from "./identity";

const base = {
  promptTemplateVersion: "personalize.v1",
  aiInstruction: "Warm and brief.",
  llmModel: "gemini-2.5-flash",
};

describe("promptFingerprint", () => {
  it("is deterministic and hex-only, at the length the schema expects", () => {
    const first = promptFingerprint(base);

    expect(promptFingerprint(base)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]+$/);
    expect(first).toHaveLength(PROMPT_FINGERPRINT_LENGTH);
  });

  it("changes when any single input changes", () => {
    const fingerprint = promptFingerprint(base);

    expect(promptFingerprint({ ...base, promptTemplateVersion: "personalize.v2" })).not.toBe(
      fingerprint
    );
    expect(promptFingerprint({ ...base, aiInstruction: "Formal and brief." })).not.toBe(fingerprint);
    expect(promptFingerprint({ ...base, aiInstruction: base.aiInstruction + " " })).not.toBe(
      fingerprint
    );
    expect(promptFingerprint({ ...base, llmModel: "gemini-2.5-pro" })).not.toBe(fingerprint);
  });

  it("joins the inputs with '|' exactly as spec 6.4 says, '|' in a value included", () => {
    // Pinned on purpose. The specified formula is a plain join, so moving a "|"
    // from one field to the next produces the same fingerprint. The collision only
    // matters within a single campaign (whose instruction and model are both its
    // owner's), so the formula is kept as specified and the limitation is recorded
    // in docs/phase-notes.md rather than silently deviating from the spec.
    const a = promptFingerprint({
      promptTemplateVersion: "personalize.v1",
      aiInstruction: "a|b",
      llmModel: "c",
    });
    const b = promptFingerprint({
      promptTemplateVersion: "personalize.v1",
      aiInstruction: "a",
      llmModel: "b|c",
    });

    expect(a).toBe(b);
  });
});

describe("draftId", () => {
  const input = {
    campaignId: "cm_campaign_1",
    recipientId: "cr_recipient_1",
    templateHash: "hash-1",
    promptFingerprint: "0123456789abcdef",
  };

  it("is deterministic, hex-only and the documented length", () => {
    const id = draftId(input);

    expect(draftId(input)).toBe(id);
    expect(id).toMatch(/^[0-9a-f]+$/);
    expect(id).toHaveLength(DRAFT_ID_LENGTH);
  });

  it("changes when any single input changes", () => {
    const id = draftId(input);

    expect(draftId({ ...input, campaignId: "cm_campaign_2" })).not.toBe(id);
    expect(draftId({ ...input, recipientId: "cr_recipient_2" })).not.toBe(id);
    expect(draftId({ ...input, templateHash: "hash-2" })).not.toBe(id);
    expect(draftId({ ...input, promptFingerprint: "fedcba9876543210" })).not.toBe(id);
  });

  it("is the same for the same campaign/recipient/template/prompt", () => {
    // This is what makes enqueue idempotent: the second call must produce the id
    // of the row that already exists.
    expect(draftId({ ...input })).toBe(draftId({ ...input }));
  });

  it("produces distinct ids for the same recipient in different campaigns", () => {
    expect(draftId({ ...input, campaignId: "other" })).not.toBe(
      draftId({ ...input, campaignId: "cm_campaign_1" })
    );
  });
});

describe("campaignPromptIdentity", () => {
  it("returns the stored identity", () => {
    expect(
      campaignPromptIdentity({
        id: "cm_1",
        promptFingerprint: "abc",
        llmModel: "gemini-2.5-flash",
        promptTemplateVersion: "personalize.v1",
      })
    ).toEqual({
      promptFingerprint: "abc",
      llmModel: "gemini-2.5-flash",
      promptTemplateVersion: "personalize.v1",
    });
  });

  it.each([
    ["promptFingerprint", { promptFingerprint: null }],
    ["llmModel", { llmModel: null }],
    ["promptTemplateVersion", { promptTemplateVersion: null }],
  ])("throws when %s is missing", (_field, override) => {
    expect(() =>
      campaignPromptIdentity({
        id: "cm_1",
        promptFingerprint: "abc",
        llmModel: "gemini-2.5-flash",
        promptTemplateVersion: "personalize.v1",
        ...override,
      })
    ).toThrow(CampaignPromptIdentityMissingError);
  });
});
