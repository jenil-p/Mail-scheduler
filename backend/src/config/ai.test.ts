import { describe, it, expect } from "vitest";
import { AI_CONFIG_ENV_KEYS, LLM_PROVIDERS, aiConfigSchema, parseAiConfig } from "./ai";

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
      rateLimitPerMin: 5,
      generateConcurrency: 1,
      dailyResetTz: "America/Los_Angeles",
      sampleSize: 5,
      fullReviewMaxRecipients: 25,
      maxRecipientsPerCampaign: 500,
      minLeadTimeMs: 300_000,
      finalizeLeadMs: 120_000,
      recipientFieldMaxLength: 200,
      recipientNoteMaxLength: 500,
      introMaxChars: 240,
      templateBodyMaxLength: 20_000,
      templateSubjectMaxLength: 300,
      // Phase 3: generate-queue retry delays and the Gemini output allowance.
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 60_000,
      maxOutputTokens: 512,
      thinkingBudget: 0,
      // Phase 5a: campaign state machine and tick interval
      instructionMaxLength: 500,
      campaignTickMs: 15_000,
      // Phase 6a: campaign send path default sender email and email staggering delay
      campaignSenderEmail: "Sendly Scheduler <scheduler@sendly.local>",
      campaignDelayBetweenEmailsMs: 2_000,
    });
  });

  it("rejects a retry ceiling below the base delay, naming the variable", () => {
    expect(() =>
      parseAiConfig({ LLM_RETRY_BASE_MS: "5000", LLM_RETRY_MAX_MS: "1000" })
    ).toThrowError(/LLM_RETRY_MAX_MS/);
  });

  it("accepts the thinking budget range Gemini allows, including 0", () => {
    expect(parseAiConfig({ LLM_THINKING_BUDGET: "0" }).thinkingBudget).toBe(0);
    expect(parseAiConfig({ LLM_THINKING_BUDGET: "128" }).thinkingBudget).toBe(128);
    expect(() => parseAiConfig({ LLM_THINKING_BUDGET: "-1" })).toThrowError(
      /LLM_THINKING_BUDGET/
    );
  });

  it("accepts a custom campaign sender email", () => {
    expect(
      parseAiConfig({ CAMPAIGN_SENDER_EMAIL: "custom@example.com" }).campaignSenderEmail
    ).toBe("custom@example.com");
  });

  it("accepts a custom campaign email staggering delay", () => {
    expect(
      parseAiConfig({ CAMPAIGN_DELAY_BETWEEN_EMAILS_MS: "3000" })
        .campaignDelayBetweenEmailsMs
    ).toBe(3000);
    expect(
      parseAiConfig({ CAMPAIGN_DELAY_BETWEEN_EMAILS_MS: "0" })
        .campaignDelayBetweenEmailsMs
    ).toBe(0);
    expect(() =>
      parseAiConfig({ CAMPAIGN_DELAY_BETWEEN_EMAILS_MS: "-1" })
    ).toThrowError(/CAMPAIGN_DELAY_BETWEEN_EMAILS_MS/);
  });

  it("leaves the daily request limit unset for the mock provider (no invented quota)", () => {
    expect(parseAiConfig({}).dailyRateLimit).toBeUndefined();
    expect(parseAiConfig({ LLM_PROVIDER: "mock" }).dailyRateLimit).toBeUndefined();
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
      AI_INSTRUCTION_MAX_LENGTH: "300",
      CAMPAIGN_TICK_MS: "5000",
    });

    expect(ai.timeoutMs).toBe(20_000);
    expect(ai.maxRetries).toBe(0);
    expect(ai.sampleSize).toBe(3);
    expect(ai.maxRecipientsPerCampaign).toBe(1000);
    expect(ai.generateConcurrency).toBe(12);
    expect(ai.instructionMaxLength).toBe(300);
    expect(ai.campaignTickMs).toBe(5000);
  });

  it.each([
    ["not-a-number", "LLM_TIMEOUT_MS"],
    ["15000.5", "LLM_TIMEOUT_MS"],
    ["-1", "LLM_MAX_RETRIES"],
    ["0", "GENERATE_CONCURRENCY"],
    ["0", "LLM_RATE_LIMIT_PER_MIN"],
    ["1.5", "LLM_RATE_LIMIT_PER_DAY"],
    ["999", "CAMPAIGN_TICK_MS"],
    ["0", "AI_INSTRUCTION_MAX_LENGTH"],
  ])("rejects %s for %s with a readable error", (value, key) => {
    expect(() => parseAiConfig({ [key]: value })).toThrowError(new RegExp(key));
  });

  it("accepts exactly mock and gemini", () => {
    expect(LLM_PROVIDERS).toEqual(["mock", "gemini"]);

    const gemini = parseAiConfig({
      LLM_PROVIDER: "gemini",
      LLM_MODEL: "some-model",
      LLM_API_KEY: "test-key",
      LLM_RATE_LIMIT_PER_DAY: "200",
    });

    expect(gemini).toMatchObject({
      provider: "gemini",
      model: "some-model",
      apiKey: "test-key",
      dailyRateLimit: 200,
    });
  });

  it.each(["anthropic", "openai", "google", "gpt"]) (
    "rejects the removed/unsupported provider %s and names LLM_PROVIDER",
    (provider) => {
      expect(() => parseAiConfig({ LLM_PROVIDER: provider })).toThrowError(/LLM_PROVIDER/);
    }
  );

  it("requires LLM_MODEL, LLM_API_KEY and LLM_RATE_LIMIT_PER_DAY for gemini", () => {
    expect(() => parseAiConfig({ LLM_PROVIDER: "gemini" })).toThrowError(
      /LLM_MODEL[\s\S]*LLM_API_KEY[\s\S]*LLM_RATE_LIMIT_PER_DAY/
    );
  });

  it("requires the daily limit even when model and key are set", () => {
    expect(() =>
      parseAiConfig({ LLM_PROVIDER: "gemini", LLM_MODEL: "m", LLM_API_KEY: "k" })
    ).toThrowError(/LLM_RATE_LIMIT_PER_DAY/);
  });

  it("accepts the mock provider with no quota configured at all", () => {
    const ai = parseAiConfig({ LLM_PROVIDER: "mock" });

    expect(ai).toMatchObject({ provider: "mock", dailyRateLimit: undefined, model: undefined });
  });

  it("treats blank LLM_PROVIDER / LLM_API_KEY / LLM_MODEL as unset", () => {
    const ai = parseAiConfig({
      LLM_PROVIDER: "",
      LLM_API_KEY: "",
      LLM_MODEL: "",
    });

    expect(ai).toMatchObject({ provider: "mock", apiKey: undefined, model: undefined });
  });

  it("treats blank values as unset for a real provider too, and still fails readably", () => {
    expect(() =>
      parseAiConfig({
        LLM_PROVIDER: "gemini",
        LLM_API_KEY: "",
        LLM_MODEL: "",
        LLM_RATE_LIMIT_PER_DAY: "200",
      })
    ).toThrowError(/LLM_MODEL[\s\S]*LLM_API_KEY/);
  });

  it("treats a blank daily limit as unset", () => {
    expect(() =>
      parseAiConfig({ LLM_PROVIDER: "gemini", LLM_MODEL: "m", LLM_API_KEY: "k", LLM_RATE_LIMIT_PER_DAY: "" })
    ).toThrowError(/LLM_RATE_LIMIT_PER_DAY/);
  });

  it("validates the daily reset time zone", () => {
    expect(parseAiConfig({ LLM_DAILY_RESET_TZ: "Europe/Berlin" }).dailyResetTz).toBe("Europe/Berlin");
    expect(() => parseAiConfig({ LLM_DAILY_RESET_TZ: "Mars/Olympus" })).toThrowError(
      /LLM_DAILY_RESET_TZ/
    );
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
