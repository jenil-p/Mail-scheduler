import { describe, it, expect } from "vitest";
import {
  mapGuardrailCodeToSentence,
  isDraftHardBlocked,
  getHardBlockExplanation,
  mapApiErrorCodeToMessage,
  HARD_BLOCK_CODES,
} from "./campaignErrors";
import { GuardrailCode, GuardrailFailure } from "@/types/campaigns";

describe("campaignErrors", () => {
  describe("mapGuardrailCodeToSentence", () => {
    const knownCodes: GuardrailCode[] = [
      "EMPTY_INTRO",
      "CONTAINS_NEWLINE",
      "TOO_LONG",
      "STARTS_WITH_GREETING",
      "FORBIDDEN_CONTENT",
      "UNGROUNDED_NUMBER",
      "UNGROUNDED_ENTITY",
      "BANNED_PHRASE",
      "INJECTION_SUSPECTED",
      "RENDER_INVALID",
    ];

    it("maps every known guardrail code to a descriptive sentence", () => {
      for (const code of knownCodes) {
        const sentence = mapGuardrailCodeToSentence(code);
        expect(sentence).toBeTruthy();
        expect(sentence).not.toBe(code);
      }
    });

    it("falls back to returning the code itself for unknown codes", () => {
      const unknown = "UNKNOWN_CODE" as GuardrailCode;
      expect(mapGuardrailCodeToSentence(unknown)).toBe("UNKNOWN_CODE");
    });
  });

  describe("isDraftHardBlocked (null-safe hard-block detection)", () => {
    it("returns false for null or undefined", () => {
      expect(isDraftHardBlocked(null)).toBe(false);
      expect(isDraftHardBlocked(undefined)).toBe(false);
      expect(isDraftHardBlocked()).toBe(false);
    });

    it("returns false for an empty array of flag reasons", () => {
      expect(isDraftHardBlocked([])).toBe(false);
    });

    it("returns false when flags only contain non-blocking codes", () => {
      const nonBlocking: GuardrailFailure[] = [
        { code: "TOO_LONG", detail: "Too long" },
        { code: "BANNED_PHRASE", detail: "Banned" },
      ];
      expect(isDraftHardBlocked(nonBlocking)).toBe(false);
    });

    it("returns true when any hard block code is present", () => {
      for (const code of HARD_BLOCK_CODES) {
        const flags: GuardrailFailure[] = [
          { code: "TOO_LONG", detail: "Too long" },
          { code: code as GuardrailCode, detail: "Hard blocked" },
        ];
        expect(isDraftHardBlocked(flags)).toBe(true);
      }
    });
  });

  describe("getHardBlockExplanation", () => {
    it("returns null for null, undefined, or empty flag reasons", () => {
      expect(getHardBlockExplanation(null)).toBeNull();
      expect(getHardBlockExplanation(undefined)).toBeNull();
      expect(getHardBlockExplanation([])).toBeNull();
    });

    it("returns null when no hard-block codes are present", () => {
      const flags: GuardrailFailure[] = [
        { code: "EMPTY_INTRO", detail: "Empty intro" },
      ];
      expect(getHardBlockExplanation(flags)).toBeNull();
    });

    it("returns an explanation detailing the hard-blocked codes", () => {
      const flags: GuardrailFailure[] = [
        { code: "FORBIDDEN_CONTENT", detail: "Forbidden" },
        { code: "INJECTION_SUSPECTED", detail: "Injection" },
      ];
      const explanation = getHardBlockExplanation(flags);
      expect(explanation).toContain("FORBIDDEN_CONTENT");
      expect(explanation).toContain("INJECTION_SUSPECTED");
    });
  });

  describe("mapApiErrorCodeToMessage", () => {
    it("handles undefined or missing error code", () => {
      expect(mapApiErrorCodeToMessage()).toBe(
        "An unexpected error occurred. Please try again."
      );
      expect(mapApiErrorCodeToMessage(undefined, undefined, "Custom fallback")).toBe(
        "Custom fallback"
      );
    });

    it("maps every documented API error code", () => {
      const codes = [
        "ILLEGAL_STATE",
        "HARD_BLOCKED",
        "STALE_DRAFT",
        "CAMPAIGN_NOT_UNDER_REVIEW",
        "VALIDATION_FAILED",
        "PAYLOAD_TOO_LARGE",
        "INVALID_JSON",
        "CAMPAIGN_NOT_FOUND",
        "DRAFT_NOT_FOUND",
        "BUDGET_WARNING",
        "IDENTITY_MISMATCH_AFTER_APPROVAL",
        "SCHEDULE_TOO_SOON",
        "FULL_REVIEW_NOT_AVAILABLE",
        "RESERVED_COLUMN",
        "TOO_MANY_RECIPIENTS",
        "AI_INSTRUCTION_NOT_ALLOWED",
        "INVALID_INSTRUCTION",
        "EMPTY_CAMPAIGN",
        "INTRO_TOO_LONG",
        "INTERNAL_ERROR",
      ];

      for (const code of codes) {
        const msg = mapApiErrorCodeToMessage(code);
        expect(msg).toBeTruthy();
        expect(msg.length).toBeGreaterThan(5);
      }
    });

    it("formats HARD_BLOCKED with details.blockedCodes", () => {
      const msg = mapApiErrorCodeToMessage("HARD_BLOCKED", {
        blockedCodes: ["RENDER_INVALID", "FORBIDDEN_CONTENT"],
      });
      expect(msg).toContain("RENDER_INVALID, FORBIDDEN_CONTENT");
    });

    it("formats VALIDATION_FAILED with details.errors or details.issues", () => {
      const withErrors = mapApiErrorCodeToMessage("VALIDATION_FAILED", {
        errors: [{ message: "First error" }, { code: "SECOND_CODE" }],
      });
      expect(withErrors).toBe("First error. SECOND_CODE");

      const withIssues = mapApiErrorCodeToMessage("VALIDATION_FAILED", {
        issues: [{ path: "email", message: "Invalid email" }],
      });
      expect(withIssues).toBe("email: Invalid email");
    });

    it("formats BUDGET_WARNING with details.needed and details.remaining", () => {
      const msg = mapApiErrorCodeToMessage("BUDGET_WARNING", {
        needed: 100,
        remaining: 25,
      });
      expect(msg).toContain("100 generations");
      expect(msg).toContain("25 remain");
    });

    it("handles unknown error code", () => {
      expect(mapApiErrorCodeToMessage("SOME_NEW_CODE")).toBe("Error: SOME_NEW_CODE");
      expect(
        mapApiErrorCodeToMessage("SOME_NEW_CODE", null, "Custom message")
      ).toBe("Custom message");
    });
  });
});
