import { describe, expect, it } from "vitest";
import { NonRetryableError, QuotaExhaustedError, RetryableError } from "./LlmClient";
import { analyzeGeminiError, classifyGeminiError, parseDurationMs } from "./geminiErrors";

/**
 * The bodies below are the shapes the Google API error model documents, written
 * out in both the REST (camelCase) and proto (snake_case) forms. The parser must
 * accept all of them, and the tests assert the *behaviour* that matters: which
 * limit it is, and whether it is retried or terminal.
 */
function body(error: unknown): string {
  return JSON.stringify({ error });
}

describe("parseDurationMs", () => {
  it("reads protobuf JSON durations", () => {
    expect(parseDurationMs("12s")).toBe(12_000);
    expect(parseDurationMs("1.5s")).toBe(1_500);
    expect(parseDurationMs("1500ms")).toBe(1_500);
    expect(parseDurationMs("1m30s")).toBe(90_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
  });

  it("reads the { seconds, nanos } object form", () => {
    expect(parseDurationMs({ seconds: 3, nanos: 500_000_000 })).toBe(3_500);
  });

  it("refuses to interpret a bare number as a duration", () => {
    // Guessing seconds vs milliseconds here is how a limit turns into a 12ms retry.
    expect(parseDurationMs(12)).toBeUndefined();
    expect(parseDurationMs("later")).toBeUndefined();
    expect(parseDurationMs(undefined)).toBeUndefined();
  });
});

describe("analyzeGeminiError", () => {
  it("recognises a per-day quota from structured violations", () => {
    const analysis = analyzeGeminiError(
      429,
      body({
        code: 429,
        message: "You exceeded your current quota.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              {
                quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                quotaValue: "50",
              },
            ],
          },
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "31s",
          },
        ],
      })
    );

    expect(analysis.scope).toBe("per_day");
    expect(analysis.status).toBe("RESOURCE_EXHAUSTED");
    expect(analysis.retryAfterMs).toBe(31_250);
    expect(analysis.quotaIds).toContain("GenerateRequestsPerDayPerProjectPerModel-FreeTier");
  });

  it("recognises a per-minute limit from the proto (snake_case) form", () => {
    const analysis = analyzeGeminiError(
      429,
      body({
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              {
                quota_metric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                quota_id: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
              },
            ],
          },
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retry_delay: "7.5s",
          },
        ],
      })
    );

    expect(analysis.scope).toBe("per_minute");
    expect(analysis.retryAfterMs).toBe(7_750);
  });

  it("prefers the day limit when a body mentions both in quotaIds", () => {
    const analysis = analyzeGeminiError(
      429,
      body({
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              { quotaId: "RequestsPerMinute" },
              { quotaId: "RequestsPerDay" },
            ],
          },
        ],
      })
    );

    expect(analysis.scope).toBe("per_day");
  });

  it("decides ONLY from structured quotaIds when present, ignoring conflicting message text", () => {
    const analysis = analyzeGeminiError(
      429,
      body({
        message: "Quota exceeded per day",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              { quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" },
            ],
          },
        ],
      })
    );

    expect(analysis.scope).toBe("per_minute");
  });

  it("falls back to the message text when there are no structured details", () => {
    const daily = analyzeGeminiError(429, body({ message: "Quota exceeded for metric: GenerateRequestsPerDayPerProjectPerModel-FreeTier" }));
    expect(daily.scope).toBe("per_day");

    const perMinute = analyzeGeminiError(429, body({ message: "429 too many requests per minute" }));
    expect(perMinute.scope).toBe("per_minute");
  });

  it("treats an unrecognised 429 as per-minute, never as the terminal daily quota", () => {
    // Misreading an unknown 429 as the daily quota would fall a whole campaign back.
    expect(analyzeGeminiError(429, "rate limited").scope).toBe("per_minute");
    expect(analyzeGeminiError(429, '{"unexpected":"shape"}').scope).toBe("per_minute");
  });

  it("redacts email-like text and keeps a non-JSON body as the message", () => {
    const analysis = analyzeGeminiError(429, "quota exceeded for priya@example.com per minute");

    expect(analysis.message).toContain("[email]");
    expect(analysis.message).not.toContain("priya@example.com");
    expect(analysis.scope).toBe("per_minute");
  });

  const VERBATIM_429 = JSON.stringify({
    error: {
      code: 429,
      message:
        "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-3.8-flash\nPlease retry in 1.855281027s.",
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.Help",
          links: [
            {
              description: "Learn more about Gemini API quotas",
              url: "https://ai.google.dev/gemini-api/docs/rate-limits",
            },
          ],
        },
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [
            {
              quotaMetric:
                "generativelanguage.googleapis.com/generate_content_free_tier_requests",
              quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
              quotaDimensions: { model: "gemini-3.8-flash", location: "global" },
              quotaValue: "5",
            },
          ],
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1s" },
      ],
    },
  });

  it("correctly analyzes the verbatim 429 fixture with max(retryDelay, message seconds) + 250ms", () => {
    const analysis = analyzeGeminiError(429, VERBATIM_429);
    expect(analysis.scope).toBe("per_minute");
    // max(1000ms, 1855ms) + 250ms = 2105ms
    expect(analysis.retryAfterMs).toBe(2105);
    expect(analysis.quotaIds).toContain(
      "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"
    );

    const error = classifyGeminiError(429, VERBATIM_429);
    expect(error).toBeInstanceOf(RetryableError);
    expect(error.code).toBe("RATE_LIMITED_PER_MINUTE");
    expect(error.retryAfterMs).toBe(2105);
  });

  it("recognises a daily quota error from the fixture with GenerateRequestsPerDay", () => {
    // Note: The daily quota failure shape (e.g. GenerateRequestsPerDayPerProjectPerModel-FreeTier)
    // is an assumption by analogy with the observed per-minute shape, not directly observed.
    const DAILY_FIXTURE = VERBATIM_429.replace(
      "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
      "GenerateRequestsPerDayPerProjectPerModel-FreeTier"
    );

    const analysis = analyzeGeminiError(429, DAILY_FIXTURE);
    expect(analysis.scope).toBe("per_day");
    expect(analysis.retryAfterMs).toBe(2105);

    const error = classifyGeminiError(429, DAILY_FIXTURE);
    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(error.code).toBe("QUOTA_EXHAUSTED");
    expect(error.retryAfterMs).toBe(2105);
  });
});

describe("classifyGeminiError", () => {
  it("maps a per-day 429 to the terminal quota error", () => {
    const error = classifyGeminiError(
      429,
      body({ message: "Quota exceeded for metric: requests_per_day" })
    );

    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(error.code).toBe("QUOTA_EXHAUSTED");
  });

  it("maps a per-minute 429 to a retryable error carrying the delay", () => {
    const error = classifyGeminiError(
      429,
      body({
        message: "rate limit",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "4s" }],
      })
    );

    expect(error).toBeInstanceOf(RetryableError);
    expect(error.code).toBe("RATE_LIMITED_PER_MINUTE");
    expect(error.retryAfterMs).toBe(4_250);
  });

  it("never leaks the raw body into the error message", () => {
    const error = classifyGeminiError(
      429,
      body({
        message: "quota exceeded for priya@example.com",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaId: "RequestsPerDay", description: "for priya@example.com" }],
          },
        ],
      })
    );

    expect(error.message).not.toContain("priya@example.com");
    expect(error.message).toContain("RequestsPerDay");
  });

  it.each([
    [401, "AUTH_FAILURE", true],
    [403, "AUTH_FAILURE", true],
    [400, "BAD_REQUEST", false],
    [422, "BAD_REQUEST", false],
  ])("maps %i to a non-retryable error", (status, code, authFailure) => {
    const error = classifyGeminiError(status, body({ message: "nope" }));

    expect(error).toBeInstanceOf(NonRetryableError);
    expect(error.code).toBe(code);
    expect(error.authFailure).toBe(authFailure);
  });

  it.each([500, 502, 503])("maps %i to a retryable server error", (status) => {
    const error = classifyGeminiError(status, "{}");

    expect(error).toBeInstanceOf(RetryableError);
    expect(error.code).toBe("SERVER_ERROR");
  });

  it("maps 504 to a retryable timeout", () => {
    const error = classifyGeminiError(504, "{}");

    expect(error).toBeInstanceOf(RetryableError);
    expect(error.code).toBe("TIMEOUT");
  });
});
