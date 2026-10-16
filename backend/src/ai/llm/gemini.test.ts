import { ApiError, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import { describe, expect, it } from "vitest";
import { NonRetryableError, QuotaExhaustedError, RetryableError } from "./LlmClient";
import { GeminiClient, type GeminiTransport } from "./gemini";

const input = { system: "system prompt", user: "user prompt", maxTokens: 150, timeoutMs: 15_000 };

interface Recorded {
  params: GenerateContentParameters[];
}

function transport(
  respond: (params: GenerateContentParameters) => GenerateContentResponse | Promise<GenerateContentResponse>,
  recorded: Recorded
): GeminiTransport {
  return {
    models: {
      async generateContent(params) {
        recorded.params.push(params);
        return respond(params);
      },
    },
  };
}

function response(overrides: Partial<GenerateContentResponse> = {}): GenerateContentResponse {
  return {
    text: '{"intro":"Hello there"}',
    modelVersion: "gemini-2.5-flash-001",
    usageMetadata: {
      promptTokenCount: 130,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 6,
      totalTokenCount: 156,
    },
    ...overrides,
  } as GenerateContentResponse;
}

async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("GeminiClient", () => {
  it("requests schema-constrained JSON and records usage from the metadata", async () => {
    const recorded: Recorded = { params: [] };
    const client = new GeminiClient({
      apiKey: "test-key",
      model: "gemini-2.5-flash",
      transport: transport(() => response(), recorded),
    });

    const result = await client.generateJson(input);

    expect(result).toEqual({
      text: '{"intro":"Hello there"}',
      model: "gemini-2.5-flash-001",
      tokensIn: 130,
      tokensOut: 26, // 156 total - 130 prompt: candidates *and* thinking tokens
    });

    const config = recorded.params[0].config;
    expect(recorded.params[0].model).toBe("gemini-2.5-flash");
    expect(recorded.params[0].contents).toBe("user prompt");
    expect(config?.systemInstruction).toBe("system prompt");
    expect(config?.responseMimeType).toBe("application/json");
    expect(config?.responseJsonSchema).toEqual({
      type: "object",
      properties: { intro: { type: "string" } },
      required: ["intro"],
    });
    expect(config?.maxOutputTokens).toBe(512);
    expect(config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
    // BullMQ owns retries; one attempt here means one provider call per attempt.
    expect(config?.httpOptions?.retryOptions?.attempts).toBe(1);
    expect(config?.httpOptions?.timeout).toBe(15_000);
  });

  it("sums candidate and thinking tokens when there is no total", async () => {
    const recorded: Recorded = { params: [] };
    const client = new GeminiClient({
      apiKey: "test-key",
      model: "m",
      transport: transport(
        () =>
          response({
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 3 },
          }),
        recorded
      ),
    });

    const result = await client.generateJson(input);

    expect(result.tokensIn).toBe(10);
    expect(result.tokensOut).toBe(7);
  });

  it("treats a MAX_TOKENS answer as a malformed (unparseable) output", async () => {
    const recorded: Recorded = { params: [] };
    const client = new GeminiClient({
      apiKey: "test-key",
      model: "m",
      transport: transport(
        () =>
          ({
            text: '{"intro":"trunc',
            candidates: [{ finishReason: "MAX_TOKENS" }],
          }) as unknown as GenerateContentResponse,
        recorded
      ),
    });

    const error = await catchError(() => client.generateJson(input));

    expect(error).toBeInstanceOf(RetryableError);
    expect((error as RetryableError).code).toBe("MALFORMED_JSON");
    expect((error as Error).message).toContain("maxOutputTokens=512");
  });

  it("returns empty text rather than throwing when the model said nothing", async () => {
    const recorded: Recorded = { params: [] };
    const client = new GeminiClient({
      apiKey: "test-key",
      model: "m",
      transport: transport(() => ({ text: undefined }) as GenerateContentResponse, recorded),
    });

    const result = await client.generateJson(input);

    expect(result.text).toBe("");
    expect(result.model).toBe("m");
  });

  it("classifies an ApiError by status, keeping the quota error terminal", async () => {
    const recorded: Recorded = { params: [] };
    const client = new GeminiClient({
      apiKey: "test-key",
      model: "m",
      transport: transport(() => {
        throw new ApiError({
          status: 429,
          message: JSON.stringify({
            error: { code: 429, message: "Quota exceeded for metric: requests per day" },
          }),
        });
      }, recorded),
    });

    const error = await catchError(() => client.generateJson(input));

    expect(error).toBeInstanceOf(QuotaExhaustedError);
  });

  it("classifies a rejected key as non-retryable auth failure", async () => {
    const recorded: Recorded = { params: [] };
    const client = new GeminiClient({
      apiKey: "test-key",
      model: "m",
      transport: transport(() => {
        throw new ApiError({ status: 403, message: JSON.stringify({ error: { code: 403 } }) });
      }, recorded),
    });

    const error = await catchError(() => client.generateJson(input));

    expect(error).toBeInstanceOf(NonRetryableError);
    expect((error as NonRetryableError).authFailure).toBe(true);
  });

  it("treats an unknown transport failure as retryable, redacting the message", async () => {
    const recorded: Recorded = { params: [] };
    const client = new GeminiClient({
      apiKey: "test-key",
      model: "m",
      transport: transport(() => {
        const error = new Error("socket hang up for priya@example.com");
        error.name = "FetchError";
        throw error;
      }, recorded),
    });

    const error = await catchError(() => client.generateJson(input));

    expect(error).toBeInstanceOf(RetryableError);
    expect((error as RetryableError).code).toBe("NETWORK_ERROR");
    expect((error as Error).message).toContain("[email]");
  });

  it("reports a timeout-shaped failure as a timeout", async () => {
    const recorded: Recorded = { params: [] };
    const client = new GeminiClient({
      apiKey: "test-key",
      model: "m",
      transport: transport(() => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }, recorded),
    });

    const error = await catchError(() => client.generateJson(input));

    expect((error as RetryableError).code).toBe("TIMEOUT");
  });
});
