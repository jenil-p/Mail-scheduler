import { describe, expect, it } from "vitest";
import { RetryableError } from "../ai/llm/LlmClient";
import { isGenerateJobData } from "./generateJob";
import {
  clampThrottleDelay,
  emailPurposeFrom,
  FALLBACK_QUOTA_EXHAUSTED,
  FALLBACK_THIN_DATA,
  parseIntro,
  TERMINAL_DRAFT_STATUSES,
} from "./generateWorker";

describe("isGenerateJobData", () => {
  const valid = { draftId: "d1", campaignId: "c1", recipientId: "r1", isSample: false };

  it("accepts a well-formed payload", () => {
    expect(isGenerateJobData(valid)).toBe(true);
  });

  it.each([
    ["missing draftId", { ...valid, draftId: undefined }],
    ["empty draftId", { ...valid, draftId: "" }],
    ["missing campaignId", { ...valid, campaignId: undefined }],
    ["missing recipientId", { ...valid, recipientId: undefined }],
    ["isSample as a string", { ...valid, isSample: "false" }],
    ["null", null],
    ["a string", "draft"],
  ])("rejects %s", (_label, value) => {
    expect(isGenerateJobData(value)).toBe(false);
  });
});

describe("parseIntro", () => {
  it("returns the intro from valid JSON", () => {
    expect(parseIntro('{"intro":"Great to meet you."}')).toBe("Great to meet you.");
  });

  it("ignores extra keys", () => {
    expect(parseIntro('{"intro":"Hi","other":1}')).toBe("Hi");
  });

  it.each([
    ["not JSON at all", "Sure! Here is your intro:"],
    ["truncated JSON", '{"intro":"Hi the'],
    ["the wrong shape", '{"opening":"Hi"}'],
    ["an empty intro", '{"intro":""}'],
    ["a null intro", '{"intro":null}'],
    ["a non-string intro", '{"intro":42}'],
    ["an array", '[{"intro":"Hi"}]'],
  ])("treats %s as a parse failure", (_label, text) => {
    try {
      parseIntro(text);
      throw new Error("expected parseIntro to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RetryableError);
      expect((error as RetryableError).code).toBe("MALFORMED_JSON");
    }
  });
});

describe("emailPurposeFrom", () => {
  it("removes the AI slot and flattens whitespace", () => {
    expect(
      emailPurposeFrom("Hi {{first_name}},\r\n\r\n{{ai_intro}}\r\n\r\nWe are running a workshop.")
    ).toBe("Hi {{first_name}}, We are running a workshop.");
  });

  it("handles the slot written with unusual spacing", () => {
    expect(emailPurposeFrom("Hello {{  ai_intro  }} world")).toBe("Hello world");
  });

  it("leaves other placeholders unresolved", () => {
    expect(emailPurposeFrom("Hi {{first_name}}, welcome to {{company}}.")).toBe(
      "Hi {{first_name}}, welcome to {{company}}."
    );
  });

  it("caps the length", () => {
    expect(emailPurposeFrom("x".repeat(1_000))).toHaveLength(300);
  });
});

describe("statuses", () => {
  it("lists every settled draft status, and not the working ones", () => {
    expect([...TERMINAL_DRAFT_STATUSES]).toEqual([
      "READY",
      "FLAGGED",
      "FALLBACK",
      "APPROVED",
      "HELD",
      "QUEUED",
    ]);
    expect(TERMINAL_DRAFT_STATUSES).not.toContain("PENDING");
    expect(TERMINAL_DRAFT_STATUSES).not.toContain("GENERATING");
  });

  it("uses the fallback reason strings the campaign queries filter on", () => {
    expect(FALLBACK_THIN_DATA).toBe("THIN_DATA");
    expect(FALLBACK_QUOTA_EXHAUSTED).toBe("QUOTA_EXHAUSTED");
  });
});

describe("clampThrottleDelay", () => {
  it("clamps a zero delay up to the minimum", () => {
    expect(clampThrottleDelay(0)).toBe(250);
  });

  it("clamps a negative delay up to the minimum", () => {
    expect(clampThrottleDelay(-500)).toBe(250);
  });

  it("clamps a sub-minimum positive delay up to the minimum", () => {
    expect(clampThrottleDelay(100)).toBe(250);
  });

  it("passes a delay inside the range through unchanged", () => {
    expect(clampThrottleDelay(1_000)).toBe(1_000);
    expect(clampThrottleDelay(300000)).toBe(300_000);
  });

  it("clamps an over-maximum delay down to the maximum", () => {
    expect(clampThrottleDelay(300_001)).toBe(300_000);
    expect(clampThrottleDelay(999_999)).toBe(300_000);
  });
});
