import { describe, it, expect } from "vitest";
import { AI_CONFIG_ENV_KEYS, aiConfigSchema, parseAiConfig } from "./ai";

describe("parseAiConfig", () => {
  it("defaults to the feature being off with the mock provider and no key", () => {
    const ai = parseAiConfig({});

    expect(ai.enabled).toBe(false);
    expect(ai.provider).toBe("mock");
    expect(ai.apiKey).toBeUndefined();
    expect(ai.model).toBeUndefined();
  });

  it("applies the documented defaults (spec section 10)", () => {
    const ai = parseAiConfig({});

    expect(ai).toMatchObject({
      timeoutMs: 15_000,
      maxRetries: 4,
      maxParseRetries: 2,
      rateLimitPerMin: 60,
      generateConcurrency: 5,
      sampleSize: 5,
      fullReviewMaxRecipients: 25,
      maxRecipientsPerCampaign: 500,
      minLeadTimeMs: 300_000,
      finalizeLeadMs: 120_000,
      recipientFieldMaxLength: 200,
      recipientNoteMaxLength: 500,
      introMaxChars: 240,
    });
  });

  it.each(["true", "TRUE", "1", "yes", "on"])("enables the feature for %s", (value) => {
    expect(parseAiConfig({ AI_PERSONALIZATION_ENABLED: value }).enabled).toBe(true);
  });

  it.each(["false", "FALSE", "0", "no", "off", ""])("disables the feature for %j", (value) => {
    expect(parseAiConfig({ AI_PERSONALIZATION_ENABLED: value }).enabled).toBe(false);
  });

  it("rejects a flag value that is not a boolean, naming the variable", () => {
    expect(() => parseAiConfig({ AI_PERSONALIZATION_ENABLED: "maybe" })).toThrowError(
      /AI_PERSONALIZATION_ENABLED/
    );
  });

  it("reads numeric settings from strings", () => {
    const ai = parseAiConfig({
      LLM_TIMEOUT_MS: "20000",
      LLM_MAX_RETRIES: "0",
      SAMPLE_SIZE: "3",
      MAX_RECIPIENTS_PER_CAMPAIGN: "1000",
      GENERATE_CONCURRENCY: "12",
    });

    expect(ai.timeoutMs).toBe(20_000);
    expect(ai.maxRetries).toBe(0);
    expect(ai.sampleSize).toBe(3);
    expect(ai.maxRecipientsPerCampaign).toBe(1000);
    expect(ai.generateConcurrency).toBe(12);
  });

  it.each([
    ["not-a-number", "LLM_TIMEOUT_MS"],
    ["15000.5", "LLM_TIMEOUT_MS"],
    ["-1", "LLM_MAX_RETRIES"],
    ["0", "GENERATE_CONCURRENCY"],
  ])("rejects %s for %s with a readable error", (value, key) => {
    const env = key === "LLM_TIMEOUT_MS" ? { LLM_TIMEOUT_MS: value } : { [key]: value };

    expect(() => parseAiConfig(env)).toThrowError(new RegExp(key));
  });

  it("accepts every supported provider", () => {
    for (const provider of ["mock", "anthropic", "openai", "google"]) {
      const ai = parseAiConfig({
        LLM_PROVIDER: provider,
        LLM_MODEL: "some-model",
        LLM_API_KEY: "test-key",
      });

      expect(ai.provider).toBe(provider);
    }
  });

  it("rejects an unsupported provider and names LLM_PROVIDER", () => {
    expect(() => parseAiConfig({ LLM_PROVIDER: "gemini" })).toThrowError(/LLM_PROVIDER/);
  });

  it("requires LLM_MODEL and LLM_API_KEY for a real provider", () => {
    expect(() => parseAiConfig({ LLM_PROVIDER: "google" })).toThrowError(
      /LLM_MODEL[\s\S]*LLM_API_KEY/
    );
  });

  it("accepts a real provider once model and key are set", () => {
    const ai = parseAiConfig({
      LLM_PROVIDER: "google",
      LLM_MODEL: "gemini-test-model",
      LLM_API_KEY: "test-key",
    });

    expect(ai).toMatchObject({ provider: "google", model: "gemini-test-model", apiKey: "test-key" });
  });

  it("rejects a finalize lead longer than the minimum scheduling lead", () => {
    expect(() =>
      parseAiConfig({ CAMPAIGN_MIN_LEAD_TIME_MS: "60000", CAMPAIGN_FINALIZE_LEAD_MS: "120000" })
    ).toThrowError(/CAMPAIGN_FINALIZE_LEAD_MS/);
  });

  it("lists every problem at once instead of only the first", () => {
    let message = "";
    try {
      parseAiConfig({ AI_PERSONALIZATION_ENABLED: "maybe", SAMPLE_SIZE: "-3" });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("AI_PERSONALIZATION_ENABLED");
    expect(message).toContain("SAMPLE_SIZE");
  });

  it("keeps the env-key map in sync with the schema", () => {
    const schemaKeys = Object.keys(aiConfigSchema.shape).sort();

    expect(Object.keys(AI_CONFIG_ENV_KEYS).sort()).toEqual(schemaKeys);
  });
});
