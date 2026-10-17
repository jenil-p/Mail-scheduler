/**
 * Turning a Gemini API error into the queue's error taxonomy.
 *
 * What the installed SDK gives us (verified against `@google/genai@2.30.0`, whose
 * `throwErrorIfNotOK` does exactly this): an `ApiError` carrying only the HTTP
 * `status` and a `message` that is `JSON.stringify(<parsed error body>)`.
 * **There is no `details` property to read** — the structured part of a 429 has
 * to be recovered from that JSON string.
 *
 * ⚠ Honesty note: the *existence* of a structured 429 body is confirmed (Google's
 * APIs return the standard `google.rpc.Status` envelope), but the exact field
 * layout of the quota/retry entries could **not** be confirmed from the official
 * docs at the time of writing. This parser therefore accepts every shape the
 * standard envelope is known to take (camelCase REST JSON, snake_case proto JSON,
 * `@type`-tagged `details`) *and* falls back to reading the human-readable
 * message text, which is the one thing we have seen for real. `scripts/gemini-smoke.ts`
 * prints a raw 429 so the shape can be confirmed against a real key; until then
 * an unrecognised 429 is treated as a per-minute limit (retryable) rather than
 * being guessed into the terminal daily-quota path, which would silently fall
 * back a whole campaign.
 */

import { redactText } from "../safeLog";
import {
  NonRetryableError,
  QuotaExhaustedError,
  RetryableError,
  type LlmError,
} from "./LlmClient";

export type GeminiLimitScope = "per_minute" | "per_day" | "unknown";

export interface GeminiErrorAnalysis {
  scope: GeminiLimitScope;
  /** Delay from a `RetryInfo`/`retryDelay` entry, when one is present. */
  retryAfterMs?: number;
  /** e.g. `RESOURCE_EXHAUSTED`, from the envelope. */
  status?: string;
  /** e.g. `RATE_LIMIT_EXCEEDED` / `QUOTA_EXCEEDED`, from an `ErrorInfo` entry. */
  reason?: string;
  /** Quota ids from `QuotaFailure.violations` — safe to log (no recipient data). */
  quotaIds: string[];
  /** The provider's own message, redacted. */
  message: string;
}

const DAY_MARKERS = [/per[_\s-]?day/i, /perday/i, /\brpd\b/i, /requests?\s+per\s+day/i];
const MINUTE_MARKERS = [
  /per[_\s-]?minute/i,
  /perminute/i,
  /\brpm\b/i,
  /\btpm\b/i,
  /per[_\s-]?second/i,
  /tokens?\s+per\s+minute/i,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/**
 * Parse a proto JSON `Duration` (`"12s"`, `"1500ms"`, `"1m30s"`) or the
 * `{ seconds, nanos }` object form into milliseconds.
 *
 * A bare number is deliberately **not** accepted: proto JSON durations are
 * strings, and guessing whether a number means seconds or milliseconds is how a
 * limit's retry delay silently becomes 12 ms. An unparsed delay just means the
 * caller uses jittered exponential backoff instead.
 */
export function parseDurationMs(value: unknown): number | undefined {
  if (isRecord(value)) {
    const seconds = typeof value.seconds === "number" ? value.seconds : undefined;
    const nanos = typeof value.nanos === "number" ? value.nanos : undefined;
    if (seconds === undefined && nanos === undefined) return undefined;
    return Math.round((seconds ?? 0) * 1000 + (nanos ?? 0) / 1_000_000);
  }

  if (typeof value !== "string") return undefined;

  const text = value.trim();
  if (text === "") return undefined;

  const hours = /(\d+(?:\.\d+)?)h/.exec(text);
  const minutes = /(\d+(?:\.\d+)?)m(?!s)/.exec(text);
  const seconds = /(\d+(?:\.\d+)?)s/.exec(text);
  const millis = /(\d+(?:\.\d+)?)ms/.exec(text);

  if (!hours && !minutes && !seconds && !millis) return undefined;

  const total =
    (hours ? Number(hours[1]) * 3_600_000 : 0) +
    (minutes ? Number(minutes[1]) * 60_000 : 0) +
    (millis ? Number(millis[1]) : 0) +
    (seconds ? Number(seconds[1]) * 1000 : 0);

  return Number.isFinite(total) ? Math.round(total) : undefined;
}

/** The `{ error: {...} }` envelope from `ApiError.message`, or the object itself. */
function errorEnvelope(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return undefined;
    return isRecord(parsed.error) ? parsed.error : parsed;
  } catch {
    return undefined;
  }
}

/** `type.googleapis.com/google.rpc.QuotaFailure` → `quotafailure`. */
function detailKind(entry: Record<string, unknown>): string {
  const type = firstString(entry["@type"], entry.type, entry.kind);
  if (!type) return "";
  return type.toLowerCase().split("/").pop() ?? "";
}

/**
 * Read everything useful out of a 429 (or any) error body: the scope of the
 * limit, any retry delay, and identifiers for logs.
 */
export function analyzeGeminiError(status: number, rawMessage: string): GeminiErrorAnalysis {
  const envelope = errorEnvelope(rawMessage);

  const quotaIds: string[] = [];
  let retryInfoDelay: number | undefined;
  let envelopeDelay: number | undefined;
  let scope: GeminiLimitScope = "unknown";
  let reason: string | undefined;

  const envelopeStatus = envelope ? firstString(envelope.status) : undefined;
  const envelopeMessage = envelope ? firstString(envelope.message) : undefined;

  // A plain (non-JSON) body: keep the text, and try the Retry-After style fields
  // that some gateways put at the top level.
  const details = envelope?.details;
  if (Array.isArray(details)) {
    for (const entry of details) {
      if (!isRecord(entry)) continue;
      const kind = detailKind(entry);

      if (kind.endsWith("quotafailure")) {
        const violations = entry.violations;
        if (Array.isArray(violations)) {
          for (const violation of violations) {
            if (!isRecord(violation)) continue;
            const id = firstString(violation.quotaId, violation.quota_id);
            const metric = firstString(violation.quotaMetric, violation.quota_metric);
            if (id) quotaIds.push(id);
            if (metric) quotaIds.push(metric);
          }
        }
      }

      if (kind.endsWith("retryinfo")) {
        retryInfoDelay ??= parseDurationMs(entry.retryDelay ?? entry.retry_delay);
      }

      if (kind.endsWith("errorinfo")) {
        reason ??= firstString(entry.reason);
      }
    }
  }

  if (envelope) {
    envelopeDelay ??= parseDurationMs(envelope.retryDelay ?? envelope.retry_delay);
    envelopeDelay ??= parseDurationMs(envelope.retryAfter ?? envelope.retry_after);
    reason ??= firstString(envelope.reason);
  }

  // 1. Scope: if the structured quotaIds/quotaMetric are present, decide from them ONLY
  // (PerDay / per_day -> per_day; PerMinute -> per_minute; a body with both -> per_day).
  // Use free-text markers only when no quota ids exist, and only on the provider's message field,
  // never on the whole raw JSON.
  // Note: The daily quota failure shape (e.g. GenerateRequestsPerDayPerProjectPerModel-FreeTier)
  // is an assumption by analogy with the observed per-minute shape, not directly observed.
  if (quotaIds.length > 0) {
    const quotaText = quotaIds.join(" ");
    const hasDay = DAY_MARKERS.some((marker) => marker.test(quotaText));
    const hasMinute = MINUTE_MARKERS.some((marker) => marker.test(quotaText));
    if (hasDay) {
      scope = "per_day";
    } else if (hasMinute) {
      scope = "per_minute";
    }
  } else {
    const providerMessage = envelopeMessage ?? (rawMessage.trim().startsWith("{") ? "" : rawMessage);
    if (providerMessage) {
      const hasDay = DAY_MARKERS.some((marker) => marker.test(providerMessage));
      const hasMinute = MINUTE_MARKERS.some((marker) => marker.test(providerMessage));
      if (hasDay) {
        scope = "per_day";
      } else if (hasMinute) {
        scope = "per_minute";
      }
    }
  }

  // 429s are per-minute unless proven otherwise; a non-429 with a day marker is
  // still reported as daily so metrics do not mislabel it.
  if (scope === "unknown" && status === 429) scope = "per_minute";

  // 2. Retry delay: use max(RetryInfo.retryDelay, seconds parsed from "Please retry in Ns") + 250 ms.
  const msgForRetry = envelopeMessage ?? rawMessage;
  const retryInMatch = /Please retry in\s+([\d.]+)\s*s/i.exec(msgForRetry);
  const messageSecondsMs = retryInMatch ? Math.round(Number(retryInMatch[1]) * 1000) : undefined;
  const baseDelay = retryInfoDelay ?? envelopeDelay;

  let retryAfterMs: number | undefined;
  if (baseDelay !== undefined || messageSecondsMs !== undefined) {
    retryAfterMs = Math.max(baseDelay ?? 0, messageSecondsMs ?? 0) + 250;
  }

  return {
    scope,
    retryAfterMs,
    status: envelopeStatus,
    reason,
    quotaIds: [...new Set(quotaIds)],
    message: redactText(envelopeMessage ?? rawMessage),
  };
}

function limitDetail(analysis: GeminiErrorAnalysis): string {
  const parts = [
    analysis.status,
    analysis.reason,
    analysis.quotaIds.length > 0 ? `quota: ${analysis.quotaIds.join(", ")}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

/**
 * Map an HTTP status (plus its body) onto the queue's error classes.
 *
 * 429 splits two ways: a per-day quota is terminal for the campaign
 * (`QuotaExhaustedError`), while a per-minute/token limit is retried honouring
 * the announced delay (`RetryableError` with `retryAfterMs`).
 */
export function classifyGeminiError(status: number, rawMessage: string): LlmError {
  if (status === 429) {
    const analysis = analyzeGeminiError(status, rawMessage);
    const detail = limitDetail(analysis);

    if (analysis.scope === "per_day") {
      return new QuotaExhaustedError(`Gemini daily quota exhausted${detail}`, {
        retryAfterMs: analysis.retryAfterMs,
      });
    }

    return new RetryableError(`Gemini rate limit${detail}`, {
      code: "RATE_LIMITED_PER_MINUTE",
      retryAfterMs: analysis.retryAfterMs,
    });
  }

  if (status === 401 || status === 403) {
    return new NonRetryableError(`Gemini rejected the API key (HTTP ${status})`, {
      code: "AUTH_FAILURE",
      authFailure: true,
    });
  }

  if (status === 400 || status === 404 || status === 422) {
    return new NonRetryableError(`Gemini rejected the request (HTTP ${status})`, {
      code: "BAD_REQUEST",
    });
  }

  if (status === 408 || status === 504) {
    return new RetryableError(`Gemini timed out (HTTP ${status})`, { code: "TIMEOUT" });
  }

  if (status >= 500) {
    return new RetryableError(`Gemini server error (HTTP ${status})`, { code: "SERVER_ERROR" });
  }

  return new NonRetryableError(`Gemini request failed (HTTP ${status})`, { code: "UNKNOWN" });
}
