import { describe, expect, it } from "vitest";
import { RetryableError } from "./llm/LlmClient";
import {
  MAX_INPUT_CHARS,
  MAX_LOGGED_MESSAGE_CHARS,
  redactText,
  safeErrorLog,
} from "./safeLog";

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
  it("scans 'a@'.repeat(10000) (20,000 chars) in well under 100ms", () => {
    // 20,000 chars of "a@" repeated — no complete address survives because the
    // input is capped to MAX_INPUT_CHARS before the regex runs, and even inside
    // the capped window each "a@" has no domain/TLD, so nothing is matched.
    const input = "a@".repeat(10_000);
    const start = performance.now();
    const result = redactText(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    // Capped to MAX_INPUT_CHARS (no address matched), then to MAX_LOGGED_MESSAGE_CHARS + ellipsis.
    expect(result).toHaveLength(MAX_LOGGED_MESSAGE_CHARS + 1);
    expect(result).toBe("a@".repeat(150) + "…");
  });

  it("still redacts a 64-char local part inside the capped window in well under 100ms", () => {
    // A real address whose local part is exactly 64 chars (RFC 5321 limit).
    // The prefix pushes the address inside the MAX_INPUT_CHARS window so the
    // regex actually sees it; the address is short enough to survive truncation.
    const local = "a".repeat(64);
    const prefix = "p".repeat(100);
    const input = prefix + local + "@x.co";
    expect(input.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
    const start = performance.now();
    const result = redactText(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result).toContain("[email]");
    expect(result).not.toContain(local + "@x.co");
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
