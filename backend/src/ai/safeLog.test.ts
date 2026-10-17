import { describe, expect, it } from "vitest";
import { RetryableError } from "./llm/LlmClient";
import { MAX_LOGGED_MESSAGE_CHARS, redactText, safeErrorLog } from "./safeLog";

describe("redactText", () => {
  it("replaces anything shaped like an email address", () => {
    expect(redactText("failed for priya@example.com while sending")).toBe(
      "failed for [email] while sending"
    );
    expect(redactText("a@b.co, c.d+e@sub.example.co.uk")).toBe("[email], [email]");
  });

  it("truncates long messages", () => {
    const redacted = redactText("x".repeat(MAX_LOGGED_MESSAGE_CHARS + 50));

    expect(redacted).toHaveLength(MAX_LOGGED_MESSAGE_CHARS + 1); // + the ellipsis
    expect(redacted.endsWith("…")).toBe(true);
  });
});

describe("redactText timing", () => {
  it("scans a 20,000-character adversarial string with no @ in well under 100ms", () => {
    // 20,000 chars with no @ — the local-part cap (RFC 5321: 64 chars max)
    // prevents O(n^2) backtracking across all starting positions.
    // redactText truncates to MAX_LOGGED_MESSAGE_CHARS + 1 (ellipsis).
    const adversarial = "a".repeat(20_000);
    const start = performance.now();
    const result = redactText(adversarial);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    // Result is truncated: 300 chars + ellipsis.
    expect(result).toHaveLength(301);
    expect(result).toBe("a".repeat(300) + "…");
  });

  it("scans 20,000 chars with a valid email near the end in well under 100ms", () => {
    // Local part is short (within RFC 5321's 64-char limit), domain is short.
    // Total = 20,000: 19,976 a's + 24-char email = 20,000.
    const withEmail = "a".repeat(19_976) + "x.algorithms@example.com";
    const start = performance.now();
    const result = redactText(withEmail);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    // Result is truncated; the email replacement is near position 19,976,
    // which is past the 300-char truncation point, so we just see truncated a's.
    expect(result).toHaveLength(301);
  });
});

describe("safeErrorLog", () => {
  it("includes the code and retry delay of an LLM error", () => {
    const logged = safeErrorLog(
      new RetryableError("429 for priya@example.com", {
        code: "RATE_LIMITED_PER_MINUTE",
        retryAfterMs: 4_000,
      })
    );

    expect(logged).toContain("RetryableError");
    expect(logged).toContain("code=RATE_LIMITED_PER_MINUTE");
    expect(logged).toContain("retryAfterMs=4000");
    expect(logged).not.toContain("priya@example.com");
    expect(logged).toContain("[email]");
  });

  it("handles plain errors, strings and unknown values", () => {
    expect(safeErrorLog(new Error("boom"))).toBe("Error: boom");
    expect(safeErrorLog("plain string")).toBe("plain string");
    expect(safeErrorLog({ weird: true })).toBe("Unknown error");
    expect(safeErrorLog(undefined)).toBe("Unknown error");
  });
});
