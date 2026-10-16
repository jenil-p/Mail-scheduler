import { describe, it, expect } from "vitest";
import { BUILT_IN_VARIABLES, isValidHttpUrl, validateTemplate } from "./template";

const linkUrl = "https://example.com/webinar";
const unsubscribeUrl = "https://example.com/unsubscribe";

function validate(overrides: Partial<Parameters<typeof validateTemplate>[0]> = {}) {
  return validateTemplate({
    subject: "Invitation: Ops Automation Webinar, Oct 28",
    body: "Hi {{first_name}},\n\n{{ai_intro}}\n\nRegister: {{link}}\n\nThanks,\nMeera\n{{unsubscribe_link}}",
    aiEnabled: true,
    csvVariables: ["first_name", "company", "role", "note"],
    linkUrl,
    unsubscribeUrl,
    ...overrides,
  });
}

function codes(overrides: Partial<Parameters<typeof validateTemplate>[0]> = {}) {
  return validate(overrides).map((issue) => issue.code);
}

describe("validateTemplate", () => {
  it("accepts the spec's example template", () => {
    expect(validate()).toEqual([]);
  });

  it("accepts a template whose CSV carries extra columns", () => {
    expect(
      validate({
        body: "Hi {{first_name}}, you are in {{city}}. {{ai_intro}}\n\n{{unsubscribe_link}}",
        csvVariables: ["first_name", "city"],
      })
    ).toEqual([]);
  });

  it("requires {{unsubscribe_link}} in the body", () => {
    expect(codes({ body: "Hi {{first_name}}\n\n{{ai_intro}}" })).toContain("MISSING_UNSUBSCRIBE_LINK");
  });

  it("requires exactly one {{ai_intro}} when AI is enabled", () => {
    expect(codes({ body: "Hi {{first_name}}\n\n{{unsubscribe_link}}" })).toContain("AI_SLOT_COUNT");
    expect(
      codes({ body: "{{ai_intro}}\n\n{{ai_intro}}\n\n{{unsubscribe_link}}" })
    ).toContain("AI_SLOT_COUNT");
  });

  it("allows a leftover slot when AI is disabled (it renders as nothing)", () => {
    expect(codes({ aiEnabled: false })).toEqual([]);
  });

  it("rejects {{ai_intro}} in the subject", () => {
    const issues = validate({ subject: "Hello {{ai_intro}}", aiEnabled: false });

    expect(issues).toEqual([
      expect.objectContaining({ code: "AI_SLOT_IN_SUBJECT", field: "subject" }),
    ]);
  });

  it("rejects unknown variables and names them", () => {
    const issues = validate({ body: "Hi {{nickname}}\n\n{{ai_intro}}\n{{unsubscribe_link}}" });

    expect(issues).toEqual([
      expect.objectContaining({ code: "UNKNOWN_VARIABLE", field: "body" }),
    ]);
    expect(issues[0].message).toContain("nickname");
  });

  it("rejects unknown variables in the subject too", () => {
    expect(codes({ subject: "Hi {{nickname}}" })).toContain("UNKNOWN_VARIABLE");
  });

  it("matches variable names case-insensitively", () => {
    expect(
      validate({
        subject: "Invite for {{Company}}",
        body: "Hi {{First_Name}}\n\n{{ai_intro}}\n\n{{unsubscribe_link}}",
      })
    ).toEqual([]);
  });

  it("rejects malformed placeholders", () => {
    const issues = validate({
      body: "Hi {{first_name}}\n\n{{ai_intro}}\n\n{{unsubscribe_link}}\n{{broken",
    });

    expect(issues).toEqual([
      expect.objectContaining({ code: "MALFORMED_PLACEHOLDER", field: "body" }),
    ]);
  });

  it("rejects empty subject and body", () => {
    expect(codes({ subject: "   ", body: "" })).toEqual(
      expect.arrayContaining(["EMPTY_SUBJECT", "EMPTY_BODY"])
    );
  });

  it("requires both links to be absolute http(s) URLs", () => {
    expect(codes({ linkUrl: "" })).toContain("INVALID_URL");
    expect(codes({ linkUrl: "ftp://example.com/x" })).toContain("INVALID_URL");
    expect(codes({ linkUrl: "javascript:alert(1)" })).toContain("INVALID_URL");
    expect(codes({ unsubscribeUrl: "/relative" })).toContain("INVALID_URL");
    expect(codes({ unsubscribeUrl: "http://example.com/u" })).toEqual([]);
  });

  it("collects every problem instead of only the first", () => {
    const issues = validate({
      subject: "",
      body: "Hi {{nickname}}",
      linkUrl: "nope",
      unsubscribeUrl: "nope",
    });

    expect(issues.map((issue) => issue.code).sort()).toEqual([
      "AI_SLOT_COUNT",
      "EMPTY_SUBJECT",
      "INVALID_URL",
      "INVALID_URL",
      "MISSING_UNSUBSCRIBE_LINK",
      "UNKNOWN_VARIABLE",
    ]);
  });

  it("exposes the built-in variable set", () => {
    expect(BUILT_IN_VARIABLES).toEqual(
      expect.arrayContaining(["first_name", "company", "role", "note", "link", "unsubscribe_link", "ai_intro"])
    );
  });
});

describe("isValidHttpUrl", () => {
  it.each(["https://example.com", "http://example.com/a?b=c#d"])("accepts %s", (url) => {
    expect(isValidHttpUrl(url)).toBe(true);
  });

  it.each(["", "example.com", "mailto:a@b.com", "ftp://x/y", "javascript:void(0)"])(
    "rejects %s",
    (url) => {
      expect(isValidHttpUrl(url)).toBe(false);
    }
  );
});
