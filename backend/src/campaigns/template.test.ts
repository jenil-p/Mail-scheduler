import { describe, it, expect } from "vitest";
import {
  BUILT_IN_VARIABLES,
  isValidHttpUrl,
  normalizeTemplateText,
  validateTemplate,
  type TemplateValidationInput,
} from "./template";

const linkUrl = "https://example.com/webinar";
const unsubscribeUrl = "https://example.com/unsubscribe";

const DEFAULT_SUBJECT_MAX_LENGTH = 300;
const DEFAULT_BODY_MAX_LENGTH = 20_000;

function validate(overrides: Partial<TemplateValidationInput> = {}) {
  return validateTemplate({
    subject: "Invitation: Ops Automation Webinar, Oct 28",
    body: "Hi {{first_name}},\n\n{{ai_intro}}\n\nRegister: {{link}}\n\nThanks,\nMeera\n{{unsubscribe_link}}",
    aiEnabled: true,
    csvVariables: ["first_name", "company", "role", "note"],
    linkUrl,
    unsubscribeUrl,
    subjectMaxLength: DEFAULT_SUBJECT_MAX_LENGTH,
    bodyMaxLength: DEFAULT_BODY_MAX_LENGTH,
    ...overrides,
  });
}

function errorCodes(overrides: Partial<TemplateValidationInput> = {}) {
  return validate(overrides).errors.map((issue) => issue.code);
}

describe("validateTemplate", () => {
  it("accepts the spec's example template", () => {
    expect(validate()).toEqual({ errors: [], warnings: [] });
  });

  it("accepts a template whose CSV carries extra columns", () => {
    expect(
      validate({
        body: "Hi {{first_name}}, you are in {{city}}. {{ai_intro}}\n\n{{unsubscribe_link}}",
        csvVariables: ["first_name", "city"],
      }).errors
    ).toEqual([]);
  });

  it("requires {{unsubscribe_link}} in the body", () => {
    expect(errorCodes({ body: "Hi {{first_name}}\n\n{{ai_intro}}" })).toContain(
      "MISSING_UNSUBSCRIBE_LINK"
    );
  });

  it("requires exactly one {{ai_intro}} when AI is enabled", () => {
    expect(errorCodes({ body: "Hi {{first_name}}\n\n{{unsubscribe_link}}" })).toContain(
      "AI_SLOT_COUNT"
    );
    expect(
      errorCodes({ body: "{{ai_intro}}\n\n{{ai_intro}}\n\n{{unsubscribe_link}}" })
    ).toContain("AI_SLOT_COUNT");
  });

  it("allows a leftover slot when AI is disabled (it renders as nothing)", () => {
    expect(errorCodes({ aiEnabled: false })).toEqual([]);
  });

  it("rejects {{ai_intro}} in the subject", () => {
    const { errors } = validate({ subject: "Hello {{ai_intro}}", aiEnabled: false });

    expect(errors).toEqual([
      expect.objectContaining({ code: "AI_SLOT_IN_SUBJECT", field: "subject" }),
    ]);
  });

  it("rejects unknown variables and names them", () => {
    const { errors } = validate({ body: "Hi {{nickname}}\n\n{{ai_intro}}\n{{unsubscribe_link}}" });

    expect(errors).toEqual([
      expect.objectContaining({ code: "UNKNOWN_VARIABLE", field: "body" }),
    ]);
    expect(errors[0].message).toContain("nickname");
  });

  it("rejects unknown variables in the subject too", () => {
    expect(errorCodes({ subject: "Hi {{nickname}}" })).toContain("UNKNOWN_VARIABLE");
  });

  it("matches variable names case-insensitively", () => {
    expect(
      validate({
        subject: "Invite for {{Company}}",
        body: "Hi {{First_Name}}\n\n{{ai_intro}}\n\n{{unsubscribe_link}}",
      }).errors
    ).toEqual([]);
  });

  it("rejects malformed placeholders", () => {
    const { errors } = validate({
      body: "Hi {{first_name}}\n\n{{ai_intro}}\n\n{{unsubscribe_link}}\n{{broken",
    });

    expect(errors).toEqual([
      expect.objectContaining({ code: "MALFORMED_PLACEHOLDER", field: "body" }),
    ]);
    expect(errors[0].message).toContain("default");
  });

  it("rejects empty subject and body", () => {
    expect(errorCodes({ subject: "   ", body: "" })).toEqual(
      expect.arrayContaining(["EMPTY_SUBJECT", "EMPTY_BODY"])
    );
  });

  it("requires both links to be absolute http(s) URLs", () => {
    expect(errorCodes({ linkUrl: "" })).toContain("INVALID_URL");
    expect(errorCodes({ linkUrl: "ftp://example.com/x" })).toContain("INVALID_URL");
    expect(errorCodes({ linkUrl: "javascript:alert(1)" })).toContain("INVALID_URL");
    expect(errorCodes({ unsubscribeUrl: "/relative" })).toContain("INVALID_URL");
    expect(errorCodes({ unsubscribeUrl: "http://example.com/u" })).toEqual([]);
  });

  it("collects every problem instead of only the first", () => {
    const { errors } = validate({
      subject: "",
      body: "Hi {{nickname}}",
      linkUrl: "nope",
      unsubscribeUrl: "nope",
    });

    expect(errors.map((issue) => issue.code).sort()).toEqual([
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

  describe("defaults", () => {
    it("accepts a template with defaults in subject and body", () => {
      expect(
        validate({
          subject: "Invite for {{company|your team}}",
          body: "Hi {{first_name|there}}\n\n{{ai_intro}}\n\n{{unsubscribe_link}}",
        }).errors
      ).toEqual([]);
    });

    it("rejects a default on the AI slot", () => {
      expect(
        errorCodes({
          body: "Hi {{first_name}}\n\n{{ai_intro|hello there}}\n\n{{unsubscribe_link}}",
        })
      ).toContain("DEFAULT_ON_AI_SLOT");
    });

    it.each(["{{company|}}", "{{company|a|b}}", `{{company|${"x".repeat(51)}}}`])(
      "rejects the invalid default in %s",
      (placeholder) => {
        const { errors } = validate({
          body: `Hi {{first_name}}\n\n{{ai_intro}}\n\n${placeholder}\n{{unsubscribe_link}}`,
        });

        expect(errors).toEqual([
          expect.objectContaining({ code: "INVALID_DEFAULT", field: "body" }),
        ]);
      }
    );

    it("rejects a blank default written with spaces", () => {
      expect(
        errorCodes({
          body: "Hi {{first_name}}\n\n{{ai_intro}}\n\n{{company|  }}\n{{unsubscribe_link}}",
        })
      ).toContain("INVALID_DEFAULT");
    });
  });

  describe("template size caps", () => {
    it("rejects a body longer than bodyMaxLength before any regex work", () => {
      // The body is too long AND the subject references an unknown variable — but
      // because the body tripwire returns immediately, the subject is never scanned
      // and the unknown-variable error does not appear.
      const longBody = "x".repeat(20_001) + "\n\n{{unsubscribe_link}}";
      const { errors } = validate({
        subject: "Hi {{nickname}}",
        body: longBody,
        aiEnabled: false,
      });
      expect(errors).toEqual([
        expect.objectContaining({ code: "TEMPLATE_TOO_LONG", field: "body" }),
      ]);
      expect(errors).not.toContainEqual(
        expect.objectContaining({ code: "UNKNOWN_VARIABLE" })
      );
    });

    it("rejects a subject longer than subjectMaxLength before any regex work", () => {
      // The subject is too long AND the body references an unknown variable — but
      // because the subject tripwire returns immediately, the body is never scanned.
      const longSubject = "x".repeat(301);
      const { errors } = validate({
        subject: longSubject,
        body: "Hi {{nickname}}\n\n{{ai_intro}}\n\n{{unsubscribe_link}}",
        aiEnabled: true,
      });
      expect(errors).toEqual([
        expect.objectContaining({ code: "TEMPLATE_TOO_LONG", field: "subject" }),
      ]);
      expect(errors).not.toContainEqual(
        expect.objectContaining({ code: "UNKNOWN_VARIABLE" })
      );
    });

    it("accepts templates at the exact limit", () => {
      // Body must be <= bodyMaxLength including the required unsubscribe_link.
      // "\n\n{{unsubscribe_link}}" = 2 + 20 = 22 chars, so 20000 - 22 = 19978 x's.
      const body = "x".repeat(19_978) + "\n\n{{unsubscribe_link}}";
      expect(
        validate({
          body,
          aiEnabled: false,
        }).errors
      ).toEqual([]);
    });
  });

  describe("unknown variables from extra columns only", () => {
    // When csvVariables comes from extraColumns only (the Phase 7 caller passes
    // csvVariables = extraColumns), built-in variables not in the CSV are unknown.
    it("rejects {{email}} as UNKNOWN_VARIABLE when only extra columns are available", () => {
      // When csvVariables comes from extraColumns only (the Phase 7 caller passes
      // csvVariables = extraColumns), built-in variables that are not in the CSV
      // are unknown — so {{email}} is rejected even though it is a built-in-like
      // name, because it is not a recognised column here.
      const { errors } = validate({
        body: "Hi {{email}}\n\n{{ai_intro}}\n\n{{unsubscribe_link}}",
        csvVariables: ["first_name", "company"], // email is NOT in the CSV
        aiEnabled: true,
      });
      expect(errors).toEqual([
        expect.objectContaining({ code: "UNKNOWN_VARIABLE", field: "body" }),
      ]);
      expect(errors[0].message).toContain("email");
    });

    it("does not reject {{email}} when it is a CSV column", () => {
      const { errors } = validate({
        body: "Hi {{email}}\n\n{{ai_intro}}\n\n{{unsubscribe_link}}",
        csvVariables: ["email", "first_name"],
        aiEnabled: true,
      });
      expect(errors).toEqual([]);
    });
  });

  describe("warnings", () => {
    // Real value maps always carry the campaign links (see buildTemplateValues).
    const recipientValues = [
      { first_name: "Priya", company: "Acme Corp", link: linkUrl, unsubscribe_link: unsubscribeUrl },
      { first_name: "Raj", link: linkUrl, unsubscribe_link: unsubscribeUrl },
      { first_name: "Sam", company: "", link: linkUrl, unsubscribe_link: unsubscribeUrl },
    ];

    it("warns when some recipients have no value and there is no default", () => {
      const { warnings } = validate({
        body: "Hi {{first_name|there}}, a note for {{company}}. {{ai_intro}}\n{{unsubscribe_link}}",
        recipientValues,
      });

      expect(warnings).toEqual([{ variable: "company", recipientsMissing: 2, total: 3 }]);
    });

    it("does not warn when the variable has a default", () => {
      const { warnings } = validate({
        body: "Hi {{first_name}}, a note for {{company|your team}}. {{ai_intro}}\n{{unsubscribe_link}}",
        recipientValues,
      });

      expect(warnings).toEqual([]);
    });

    it("does not warn about the AI slot", () => {
      const { warnings } = validate({ recipientValues });

      expect(warnings).toEqual([]);
    });

    it("warns per variable, in template order, and only when data is available", () => {
      const { warnings } = validate({
        body: "Hi {{first_name}}, {{role}} at {{company}}. {{ai_intro}}\n{{unsubscribe_link}}",
        csvVariables: ["first_name", "company", "role"],
        recipientValues,
      });

      expect(warnings).toEqual([
        { variable: "role", recipientsMissing: 3, total: 3 },
        { variable: "company", recipientsMissing: 2, total: 3 },
      ]);
    });

    it("reports nothing when there are no recipients to check", () => {
      expect(validate().warnings).toEqual([]);
    });
  });
});

describe("normalizeTemplateText", () => {
  it("normalises CRLF and CR before the template is saved and hashed", () => {
    expect(normalizeTemplateText("A\r\nB\rC\nD")).toBe("A\nB\nC\nD");
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
