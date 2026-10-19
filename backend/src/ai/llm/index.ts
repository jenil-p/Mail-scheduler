/**
 * Provider factory (spec section 7.1).
 *
 * `mock` and `gemini` are the only providers, and `mock` is the default, so the
 * whole feature runs with zero configuration and every test runs offline (NFR-7).
 * The Gemini client is only constructed when it is actually selected, so a mock
 * deployment never builds an SDK client.
 */

import type { AiConfig } from "../../config/ai";
import type { LlmClient } from "./LlmClient";
import { GeminiClient } from "./gemini";
import { MockLlmClient } from "./mock";

/** Model id recorded when the mock provider is used. Part of the fingerprint. */
export const MOCK_MODEL_ID = "mock-model";

/**
 * Resolve the effective model name for an AI config.
 * Used by createLlmClient for client.model and by flow.ts for campaign live identity.
 */
export function resolveModelName(ai: AiConfig): string {
  if (ai.provider === "gemini") {
    return ai.model ?? "";
  }
  return ai.model ?? MOCK_MODEL_ID;
}

export function createLlmClient(ai: AiConfig): LlmClient {
  const model = resolveModelName(ai);
  if (ai.provider === "gemini") {
    if (!ai.apiKey || !model) {
      // Config validation already rejects this combination at startup; this is
      // the belt-and-braces version for a caller that built the config by hand.
      throw new Error(
        "LLM_PROVIDER=gemini needs both LLM_API_KEY and LLM_MODEL — check the AI personalization config"
      );
    }

    return new GeminiClient({
      apiKey: ai.apiKey,
      model,
      maxOutputTokens: ai.maxOutputTokens,
      thinkingBudget: ai.thinkingBudget,
    });
  }

  return new MockLlmClient({ model });
}

export { GeminiClient, MockLlmClient };
export type { LlmClient };
