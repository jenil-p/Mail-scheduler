/**
 * Gemini provider (spec section 7.2's provider half; decision in the Phase 3 notes).
 *
 * Verified against the **installed** SDK `@google/genai@2.30.0` before writing
 * (not from memory, and not from a different major version's docs):
 *
 * - the documented entry point is `ai.models.generateContent({ model, contents, config })`
 *   (the newer `ai.interactions.create` API also exists in this package, but every
 *   type used below is verified in the installed `genai.d.ts`);
 * - `config.responseMimeType: "application/json"` plus `config.responseJsonSchema`
 *   (a plain JSON Schema; the SDK moves legacy `responseSchema` values across for
 *   backwards compatibility) is how `{ intro }` is requested;
 * - `config.thinkingConfig.thinkingBudget` exists — `0` disables thinking;
 * - `response.usageMetadata` carries `promptTokenCount`, `candidatesTokenCount`,
 *   `thoughtsTokenCount` and `totalTokenCount`;
 * - on a non-2xx the SDK throws `ApiError` with **only** `status` and a `message`
 *   that is `JSON.stringify(errorBody)` — see `geminiErrors.ts`, which is where the
 *   429 body is unpicked;
 * - the SDK retries 429/5xx up to 5 times by itself, which we must switch off:
 *   BullMQ owns retries here (decision A3), otherwise one job would silently make
 *   six provider calls per attempt.
 *
 * Thinking tokens are billed **and counted** as output tokens, so `maxOutputTokens`
 * has to cover thinking *plus* the visible JSON. `DEFAULT_MAX_OUTPUT_TOKENS` is
 * therefore generous relative to a ~150-token answer, so that a model which
 * enforces a minimum thinking budget (Gemini 2.5 Pro cannot disable thinking)
 * still has room for the JSON instead of returning a truncated object. A truncated
 * (or `MAX_TOKENS`) response is surfaced as a `MALFORMED_JSON` failure, which the
 * worker retries within the parse budget and then falls back on.
 */

import {
  ApiError,
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";
import {
  INTRO_RESPONSE_SCHEMA,
  RetryableError,
  type LlmClient,
  type LlmGenerateInput,
  type LlmGenerateResult,
} from "./LlmClient";
import { classifyGeminiError } from "./geminiErrors";
import { redactText } from "../safeLog";

/** Total output allowance, thinking tokens included. Configurable per deployment. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 512;

/** 0 = thinking disabled. Some models require a minimum (e.g. 128 on 2.5 Pro). */
export const DEFAULT_THINKING_BUDGET = 0;

/** Deterministic, short, plain-text answers — not a creative writing task. */
export const DEFAULT_TEMPERATURE = 0.4;

/** The slice of `GoogleGenAI` this client uses, so tests can inject a stub. */
export interface GeminiTransport {
  models: {
    generateContent: (params: GenerateContentParameters) => Promise<GenerateContentResponse>;
  };
}

export interface GeminiClientOptions {
  apiKey: string;
  model: string;
  maxOutputTokens?: number;
  thinkingBudget?: number;
  temperature?: number;
  /** Injectable for unit tests; production builds the real SDK client. */
  transport?: GeminiTransport;
}

export class GeminiClient implements LlmClient {
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly thinkingBudget: number;

  private readonly temperature: number;
  private readonly transport: GeminiTransport;

  constructor(options: GeminiClientOptions) {
    this.model = options.model;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.thinkingBudget = options.thinkingBudget ?? DEFAULT_THINKING_BUDGET;
    this.temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    this.transport = options.transport ?? createSdkTransport(options.apiKey);
  }

  async generateJson(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    let response: GenerateContentResponse;

    try {
      response = await this.transport.models.generateContent({
        model: this.model,
        contents: input.user,
        config: {
          systemInstruction: input.system,
          temperature: this.temperature,
          maxOutputTokens: this.maxOutputTokens,
          responseMimeType: "application/json",
          responseJsonSchema: INTRO_RESPONSE_SCHEMA,
          thinkingConfig: { thinkingBudget: this.thinkingBudget },
          httpOptions: {
            timeout: input.timeoutMs,
            // BullMQ owns retries; see the header comment.
            retryOptions: { attempts: 1 },
          },
        },
      });
    } catch (error) {
      throw toLlmError(error);
    }

    const finishReason = response.candidates?.[0]?.finishReason;

    if (finishReason === "MAX_TOKENS") {
      throw new RetryableError(
        `Gemini stopped at maxOutputTokens=${this.maxOutputTokens} (thinking tokens count towards it) — the JSON is truncated`,
        { code: "MALFORMED_JSON" }
      );
    }

    const text = response.text ?? "";
    const usage = response.usageMetadata;
    const tokensIn = usage?.promptTokenCount ?? 0;
    const tokensOut =
      usage?.totalTokenCount !== undefined
        ? Math.max(0, usage.totalTokenCount - tokensIn)
        : (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);

    return {
      text,
      model: response.modelVersion ?? this.model,
      tokensIn,
      tokensOut,
    };
  }
}

/** The real SDK client. Only constructed for the `gemini` provider. */
function createSdkTransport(apiKey: string): GeminiTransport {
  return new GoogleGenAI({ apiKey });
}

/** SDK errors are `ApiError` (status + JSON-stringified body); everything else is transport. */
function toLlmError(error: unknown): Error {
  if (error instanceof ApiError) {
    return classifyGeminiError(error.status, error.message);
  }

  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const message = redactText(error.message);

    if (name.includes("abort") || name.includes("timeout")) {
      return new RetryableError(`Gemini request timed out: ${message}`, {
        code: "TIMEOUT",
        cause: error,
      });
    }

    // Unknown SDK/fetch failures are treated as transient: they cost one retry,
    // whereas classifying a temporary network fault as permanent would fall the
    // draft back for no reason.
    return new RetryableError(`Gemini request failed: ${message}`, {
      code: "NETWORK_ERROR",
      cause: error,
    });
  }

  return new RetryableError("Gemini request failed with a non-Error value", {
    code: "NETWORK_ERROR",
  });
}
