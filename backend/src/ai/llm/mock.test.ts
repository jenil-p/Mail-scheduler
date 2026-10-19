import { describe, expect, it } from "vitest";
import {
  NonRetryableError,
  QuotaExhaustedError,
  RetryableError,
} from "./LlmClient";
import { MockLlmClient, type MockStep } from "./mock";

const input = { system: "system", user: "user", maxTokens: 150, timeoutMs: 1_000 };

async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("MockLlmClient", () => {
  it("returns deterministic JSON and records every prompt it was given", async () => {
    const client = new MockLlmClient({ model: "test-model" });

    const result = await client.generateJson(input);

    expect(JSON.parse(result.text)).toEqual({ intro: "Mock intro for call 1" });
    expect(result.model).toBe("test-model");
    expect(result.tokensIn).toBeGreaterThan(0);
    expect(result.tokensOut).toBeGreaterThan(0);
    expect(client.calls).toEqual([input]);
    expect(client.callCount).toBe(1);
  });

  it("walks the script in order and repeats the last step forever", async () => {
    const client = new MockLlmClient({
      script: [
        { kind: "success", intro: "first" },
        { kind: "success", intro: "then this" },
      ],
    });

    const intros = [];
    for (let i = 0; i < 4; i++) {
      intros.push(JSON.parse((await client.generateJson(input)).text).intro);
    }

    expect(intros).toEqual(["first", "then this", "then this", "then this"]);
    expect(client.callCount).toBe(4);
  });

  it("carries the retry delay on a per-minute 429", async () => {
    const client = new MockLlmClient({ script: [{ kind: "rate_limited", retryAfterMs: 1_500 }] });

    const error = await catchError(() => client.generateJson(input));

    expect(error).toBeInstanceOf(RetryableError);
    expect((error as RetryableError).code).toBe("RATE_LIMITED_PER_MINUTE");
    expect((error as RetryableError).retryAfterMs).toBe(1_500);
  });

  it("raises the daily quota as terminal, not retryable", async () => {
    const client = new MockLlmClient({ script: [{ kind: "daily_quota" }] });

    const error = await catchError(() => client.generateJson(input));

    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect((error as QuotaExhaustedError).code).toBe("QUOTA_EXHAUSTED");
  });

  it("raises a 5xx as retryable and a 401 as auth failure", async () => {
    const serverError = await catchError(() =>
      new MockLlmClient({ script: [{ kind: "server_error" }] }).generateJson(input)
    );
    expect(serverError).toBeInstanceOf(RetryableError);
    expect((serverError as RetryableError).code).toBe("SERVER_ERROR");

    const timeout = await catchError(() =>
      new MockLlmClient({ script: [{ kind: "timeout" }] }).generateJson(input)
    );
    expect((timeout as RetryableError).code).toBe("TIMEOUT");

    const auth = await catchError(() =>
      new MockLlmClient({ script: [{ kind: "auth", status: 401 }] }).generateJson(input)
    );
    expect(auth).toBeInstanceOf(NonRetryableError);
    expect((auth as NonRetryableError).authFailure).toBe(true);

    const badRequest = await catchError(() =>
      new MockLlmClient({ script: [{ kind: "bad_request" }] }).generateJson(input)
    );
    expect(badRequest).toBeInstanceOf(NonRetryableError);
    expect((badRequest as NonRetryableError).authFailure).toBe(false);
  });

  it("returns syntactically broken text for malformed_json, without throwing", async () => {
    const client = new MockLlmClient({ script: [{ kind: "malformed_json" }] });

    const result = await client.generateJson(input);

    expect(() => JSON.parse(result.text)).toThrow();
  });

  it("honours a per-step delay so a call can be observed in flight", async () => {
    const client = new MockLlmClient({
      script: [{ kind: "success", intro: "slow", delayMs: 40 }] as MockStep[],
    });

    const started = Date.now();
    await client.generateJson(input);

    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });
});

describe("resolveModelName", () => {
  it("resolves to mock-model for mock provider when model is not set", async () => {
    const { resolveModelName, createLlmClient, MOCK_MODEL_ID } = await import("./index");
    const { parseAiConfig } = await import("../../config/ai");

    const ai = parseAiConfig({ LLM_PROVIDER: "mock" });
    expect(resolveModelName(ai)).toBe(MOCK_MODEL_ID);

    const client = createLlmClient(ai);
    expect(client.model).toBe(MOCK_MODEL_ID);
  });

  it("resolves to explicit model when set", async () => {
    const { resolveModelName, createLlmClient } = await import("./index");
    const { parseAiConfig } = await import("../../config/ai");

    const ai = parseAiConfig({ LLM_PROVIDER: "mock", LLM_MODEL: "custom-mock" });
    expect(resolveModelName(ai)).toBe("custom-mock");

    const client = createLlmClient(ai);
    expect(client.model).toBe("custom-mock");
  });
});
