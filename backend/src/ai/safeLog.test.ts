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
