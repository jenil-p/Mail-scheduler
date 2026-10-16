/**
 * Deterministic mock provider (NFR-7).
 *
 * Every test in this feature runs against this client, so nothing touches the
 * network and nothing costs money. It is scripted per call: the Nth call returns
 * the Nth step, and the last step repeats forever, which is how "fails twice then
 * succeeds" or "always fails" tests are written.
 *
 * It records the prompts it was given so tests can assert *that* a call happened
 * (and with what shape) without any test ever logging recipient data.
 */

import {
  LlmError,
  NonRetryableError,
  QuotaExhaustedError,
  RetryableError,
  type LlmClient,
  type LlmGenerateInput,
  type LlmGenerateResult,
} from "./LlmClient";

export type MockStep =
  | {
      kind: "success";
      intro?: string;
      tokensIn?: number;
      tokensOut?: number;
      /** Per-step latency, for tests that need a call to be visibly in flight. */
      delayMs?: number;
    }
  | { kind: "rate_limited"; retryAfterMs?: number; message?: string }
  | { kind: "daily_quota"; message?: string }
  | { kind: "server_error"; message?: string }
  | { kind: "timeout" }
  | { kind: "malformed_json"; text?: string }
  | { kind: "auth"; status?: 401 | 403 }
  | { kind: "bad_request" };

export interface MockLlmClientOptions {
  model?: string;
  /** Steps returned in order; the final step repeats. Default: always succeed. */
  script?: MockStep[];
  /** Latency per call, so tests can exercise slow providers deliberately. */
  latencyMs?: number;
}

export class MockLlmClient implements LlmClient {
  readonly model: string;
  readonly calls: LlmGenerateInput[] = [];
  /** How many times a model call was attempted (including failures). */
  callCount = 0;

  private readonly script: MockStep[];
  private readonly latencyMs: number;

  constructor(options: MockLlmClientOptions = {}) {
    this.model = options.model ?? "mock-model";
    this.script = options.script?.length ? options.script : [{ kind: "success" }];
    this.latencyMs = options.latencyMs ?? 0;
  }

  async generateJson(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    const step = this.script[Math.min(this.callCount, this.script.length - 1)];
    this.callCount += 1;
    this.calls.push(input);

    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    switch (step.kind) {
      case "success": {
        if (step.delayMs && step.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, step.delayMs));
        }

        const intro = step.intro ?? `Mock intro for call ${this.callCount}`;
        return {
          text: JSON.stringify({ intro }),
          model: this.model,
          tokensIn: step.tokensIn ?? 120,
          tokensOut: step.tokensOut ?? 24,
        };
      }

      case "rate_limited":
        throw new RetryableError(step.message ?? "429 rate limited (per minute)", {
          code: "RATE_LIMITED_PER_MINUTE",
          retryAfterMs: step.retryAfterMs,
        });

      case "daily_quota":
        throw new QuotaExhaustedError(step.message ?? "429 daily quota exhausted");

      case "server_error":
        throw new RetryableError(step.message ?? "503 service unavailable", {
          code: "SERVER_ERROR",
        });

      case "timeout":
        throw new RetryableError("Request timed out", { code: "TIMEOUT" });

      case "malformed_json":
        return {
          text: step.text ?? '{"intro": ',
          model: this.model,
          tokensIn: 120,
          tokensOut: 8,
        };

      case "auth":
        throw new NonRetryableError("401 API key not valid", {
          code: "AUTH_FAILURE",
          authFailure: true,
        });

      case "bad_request":
        throw new NonRetryableError("400 invalid request", { code: "BAD_REQUEST" });

      default: {
        const exhaustive: never = step;
        throw new LlmError(`Unhandled mock step: ${JSON.stringify(exhaustive)}`, {
          code: "UNKNOWN",
        });
      }
    }
  }
}
