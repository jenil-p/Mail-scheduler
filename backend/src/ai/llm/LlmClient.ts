/**
 * LLM provider interface (spec section 7.1) and the errors the worker reasons about.
 *
 * The provider is behind this interface so the whole feature is testable with the
 * deterministic `mock` implementation (NFR-7): no network, no cost, no flakiness.
 */

import { z } from "zod";

export interface LlmPrompt {
  system: string;
  user: string;
}

export interface LlmGenerateInput extends LlmPrompt {
  maxTokens: number;
  timeoutMs: number;
}

export interface LlmGenerateResult {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export interface LlmClient {
  /** The model id this client calls; part of the prompt fingerprint. */
  readonly model: string;
  generateJson(input: LlmGenerateInput): Promise<LlmGenerateResult>;
}

/**
 * The only recipient fields that ever reach a provider (spec section 7.2): the
 * four recognized columns, never `extra` and never the email address itself.
 */
export interface PromptRecipientData {
  first_name?: string | null;
  company?: string | null;
  role?: string | null;
  note?: string | null;
}

/** The model's structured output (spec FR-6). */
export const introSchema = z.object({
  intro: z.string().min(1),
});

export type IntroPayload = z.infer<typeof introSchema>;

/** JSON Schema handed to providers that support structured output. */
export const INTRO_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intro: { type: "string" },
  },
  required: ["intro"],
} as const;

export type LlmErrorCode =
  | "RATE_LIMITED_PER_MINUTE"
  | "RATE_LIMITED_TOKEN"
  | "QUOTA_EXHAUSTED"
  | "SERVER_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "MALFORMED_JSON"
  | "AUTH_FAILURE"
  | "BAD_REQUEST"
  | "UNKNOWN";

export interface LlmErrorOptions {
  code: LlmErrorCode;
  /** Honoured as a retry delay (from `Retry-After` or the error's retry info). */
  retryAfterMs?: number;
  /** 400/401/403: the caller must not retry. */
  authFailure?: boolean;
  cause?: unknown;
}

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly retryAfterMs?: number;
  readonly authFailure: boolean;

  constructor(message: string, options: LlmErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.authFailure = options.authFailure ?? false;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** Transient: network, timeout, 429, 5xx. Retried by BullMQ within the budget. */
export class RetryableError extends LlmError {}

/** Permanent for this call: 400/401/403 and anything else not worth retrying. */
export class NonRetryableError extends LlmError {}

/**
 * The provider's quota is used up for the day. Not retried: the draft falls back
 * and the campaign's remaining drafts are short-circuited.
 */
export class QuotaExhaustedError extends LlmError {
  constructor(message: string, options: Omit<LlmErrorOptions, "code"> = {}) {
    super(message, { ...options, code: "QUOTA_EXHAUSTED" });
  }
}

/** HTTP-status based classification shared by real providers. */
export function classifyHttpStatus(status: number, message: string): LlmError {
  if (status === 401 || status === 403) {
    return new NonRetryableError(message, { code: "AUTH_FAILURE", authFailure: true });
  }

  if (status === 400 || status === 404 || status === 422) {
    return new NonRetryableError(message, { code: "BAD_REQUEST" });
  }

  if (status === 429) {
    return new RetryableError(message, { code: "RATE_LIMITED_PER_MINUTE" });
  }

  if (status >= 500) {
    return new RetryableError(message, { code: "SERVER_ERROR" });
  }

  return new NonRetryableError(message, { code: "UNKNOWN" });
}
