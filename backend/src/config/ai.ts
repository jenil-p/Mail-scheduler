import { z } from "zod";

/**
 * AI personalization config (spec section 10).
 *
 * Everything here has a sane default so the feature is a no-op unless
 * `AI_PERSONALIZATION_ENABLED` is true, and the `mock` provider works with zero
 * configuration (no API key, no network, no cost).
 *
 * Providers are deliberately limited to `mock` (deterministic, offline, used by
 * every test and by local dev) and `gemini` (the Google Gemini API on its free
 * tier). No Gemini quota number is hardcoded anywhere in this codebase: the
 * per-minute and per-day limits are copied by the operator from the AI Studio
 * rate-limit page for the model they picked, because Google changes them and
 * they differ per model. There is intentionally no default for
 * `LLM_RATE_LIMIT_PER_DAY`.
 *
 * Values are parsed from the environment and validated once at startup —
 * `parseAiConfig` throws with a readable message instead of failing later
 * inside a worker with a half-broken config.
 */

export const LLM_PROVIDERS = ["mock", "gemini"] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** "true" / "1" / "yes" / "on" and "false" / "0" / "no" / "off" (case-insensitive). */
function envFlag(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === "") return defaultValue;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
    }
    return value;
  }, z.boolean());
}

/** A blank environment value counts as unset, exactly like a missing one. */
function blankAsUnset<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema);
}

function envInt(defaultValue: number, bounds: { min: number; max: number }) {
  return z.preprocess((value) => {
    if (value === undefined || value === "") return defaultValue;
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return value;
  }, z.number().int().min(bounds.min).max(bounds.max));
}

/**
 * Integer with no default: unset stays undefined so a required-only-for-gemini
 * setting can be reported as missing instead of silently invented.
 */
function envOptionalInt(bounds: { min: number; max: number }) {
  return z.preprocess((value) => {
    if (value === undefined || value === "") return undefined;
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return value;
  }, z.number().int().min(bounds.min).max(bounds.max).optional());
}

/** IANA zone name, checked against the runtime's own time-zone database. */
function envTimeZone(defaultValue: string) {
  return z.preprocess(
    (value) => (value === undefined || value === "" ? defaultValue : value),
    z.string().refine(
      (timeZone) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'must be a valid IANA time zone name, e.g. "America/Los_Angeles"' }
    )
  );
}

export const aiConfigSchema = z
  .object({
    enabled: envFlag(false),
    provider: blankAsUnset(z.enum(LLM_PROVIDERS).default("mock")),
    apiKey: blankAsUnset(z.string().min(1).optional()),
    model: blankAsUnset(z.string().min(1).optional()),
    timeoutMs: envInt(15_000, { min: 1_000, max: 120_000 }),
    maxRetries: envInt(4, { min: 0, max: 10 }),
    maxParseRetries: envInt(2, { min: 0, max: 10 }),
    // Retry delays for the generate queue's custom backoff (decision A3). Base and
    // maximum only: the jitter is in code (src/ai/llm/backoff.ts).
    retryBackoffBaseMs: envInt(2_000, { min: 1, max: 600_000 }),
    retryBackoffMaxMs: envInt(60_000, { min: 1, max: 3_600_000 }),
    // Total output allowance for one call, thinking tokens included — see the
    // header of src/ai/llm/gemini.ts for why it is not simply the answer length.
    maxOutputTokens: envInt(512, { min: 32, max: 32_768 }),
    // 0 disables thinking. Some models (e.g. Gemini 2.5 Pro) require a minimum,
    // so this is configurable rather than hardcoded.
    thinkingBudget: envInt(0, { min: 0, max: 32_768 }),
    rateLimitPerMin: envInt(5, { min: 1, max: 100_000 }),
    dailyRateLimit: envOptionalInt({ min: 1, max: 10_000_000 }),
    dailyResetTz: envTimeZone("America/Los_Angeles"),
    generateConcurrency: envInt(1, { min: 1, max: 100 }),
    sampleSize: envInt(5, { min: 1, max: 50 }),
    fullReviewMaxRecipients: envInt(25, { min: 1, max: 1000 }),
    maxRecipientsPerCampaign: envInt(500, { min: 1, max: 100_000 }),
    minLeadTimeMs: envInt(5 * 60_000, { min: 0, max: 24 * 60 * 60_000 }),
    finalizeLeadMs: envInt(2 * 60_000, { min: 0, max: 60 * 60_000 }),
    recipientFieldMaxLength: envInt(200, { min: 1, max: 10_000 }),
    recipientNoteMaxLength: envInt(500, { min: 1, max: 10_000 }),
    introMaxChars: envInt(240, { min: 1, max: 2_000 }),
  })
  .superRefine((value, ctx) => {
    // Provider-independent rules first: they must hold for `mock` too.
    if (value.retryBackoffBaseMs > value.retryBackoffMaxMs) {
      ctx.addIssue({
        code: "custom",
        path: ["retryBackoffMaxMs"],
        message:
          "LLM_RETRY_MAX_MS must be at least LLM_RETRY_BASE_MS, otherwise the retry delay would shrink with each attempt",
      });
    }

    if (value.finalizeLeadMs > value.minLeadTimeMs) {
      ctx.addIssue({
        code: "custom",
        path: ["finalizeLeadMs"],
        message:
          "CAMPAIGN_FINALIZE_LEAD_MS must not exceed CAMPAIGN_MIN_LEAD_TIME_MS, " +
          "otherwise the finalize job would fire before the campaign is even schedulable",
      });
    }

    if (value.provider === "mock") return;

    // Gemini needs the full call identity, and it is part of the prompt
    // fingerprint so it must be explicit.
    if (!value.model) {
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: 'LLM_MODEL is required when LLM_PROVIDER is not "mock" (it is part of the prompt fingerprint)',
      });
    }

    if (!value.apiKey) {
      ctx.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: 'LLM_API_KEY is required when LLM_PROVIDER is not "mock"',
      });
    }

    if (value.dailyRateLimit === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["dailyRateLimit"],
        message:
          "LLM_RATE_LIMIT_PER_DAY is required when LLM_PROVIDER is not \"mock\" — copy the daily request " +
          "limit for your model from the AI Studio rate-limit page (it is not hardcoded here because it " +
          "differs per model and changes over time)",
      });
    }
  });

export type AiConfig = z.infer<typeof aiConfigSchema>;

/** The environment variable each config field is read from. */
export const AI_CONFIG_ENV_KEYS = {
  enabled: "AI_PERSONALIZATION_ENABLED",
  provider: "LLM_PROVIDER",
  apiKey: "LLM_API_KEY",
  model: "LLM_MODEL",
  timeoutMs: "LLM_TIMEOUT_MS",
  maxRetries: "LLM_MAX_RETRIES",
  maxParseRetries: "LLM_MAX_PARSE_RETRIES",
  retryBackoffBaseMs: "LLM_RETRY_BASE_MS",
  retryBackoffMaxMs: "LLM_RETRY_MAX_MS",
  maxOutputTokens: "LLM_MAX_OUTPUT_TOKENS",
  thinkingBudget: "LLM_THINKING_BUDGET",
  rateLimitPerMin: "LLM_RATE_LIMIT_PER_MIN",
  dailyRateLimit: "LLM_RATE_LIMIT_PER_DAY",
  dailyResetTz: "LLM_DAILY_RESET_TZ",
  generateConcurrency: "GENERATE_CONCURRENCY",
  sampleSize: "SAMPLE_SIZE",
  fullReviewMaxRecipients: "FULL_REVIEW_MAX_RECIPIENTS",
  maxRecipientsPerCampaign: "MAX_RECIPIENTS_PER_CAMPAIGN",
  minLeadTimeMs: "CAMPAIGN_MIN_LEAD_TIME_MS",
  finalizeLeadMs: "CAMPAIGN_FINALIZE_LEAD_MS",
  recipientFieldMaxLength: "RECIPIENT_FIELD_MAX_LENGTH",
  recipientNoteMaxLength: "RECIPIENT_NOTE_MAX_LENGTH",
  introMaxChars: "AI_INTRO_MAX_CHARS",
} as const satisfies Record<keyof AiConfig, string>;

/**
 * Map `process.env` onto the config object. Pure, so tests can pass a plain object.
 * Throws a single readable error listing every invalid variable.
 */
export function parseAiConfig(env: Record<string, string | undefined>): AiConfig {
  const result = aiConfigSchema.safeParse({
    enabled: env.AI_PERSONALIZATION_ENABLED,
    provider: env.LLM_PROVIDER,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxRetries: env.LLM_MAX_RETRIES,
    maxParseRetries: env.LLM_MAX_PARSE_RETRIES,
    retryBackoffBaseMs: env.LLM_RETRY_BASE_MS,
    retryBackoffMaxMs: env.LLM_RETRY_MAX_MS,
    maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
    thinkingBudget: env.LLM_THINKING_BUDGET,
    rateLimitPerMin: env.LLM_RATE_LIMIT_PER_MIN,
    dailyRateLimit: env.LLM_RATE_LIMIT_PER_DAY,
    dailyResetTz: env.LLM_DAILY_RESET_TZ,
    generateConcurrency: env.GENERATE_CONCURRENCY,
    sampleSize: env.SAMPLE_SIZE,
    fullReviewMaxRecipients: env.FULL_REVIEW_MAX_RECIPIENTS,
    maxRecipientsPerCampaign: env.MAX_RECIPIENTS_PER_CAMPAIGN,
    minLeadTimeMs: env.CAMPAIGN_MIN_LEAD_TIME_MS,
    finalizeLeadMs: env.CAMPAIGN_FINALIZE_LEAD_MS,
    recipientFieldMaxLength: env.RECIPIENT_FIELD_MAX_LENGTH,
    recipientNoteMaxLength: env.RECIPIENT_NOTE_MAX_LENGTH,
    introMaxChars: env.AI_INTRO_MAX_CHARS,
  });

  if (!result.success) {
    // Report the environment variable the operator actually set, not the internal key.
    const problems = result.error.issues
      .map((issue) => {
        const field = issue.path[0];
        const name =
          typeof field === "string" && field in AI_CONFIG_ENV_KEYS
            ? AI_CONFIG_ENV_KEYS[field as keyof AiConfig]
            : String(field ?? "config");
        return `  - ${name}: ${issue.message}`;
      })
      .join("\n");

    throw new Error(`Invalid AI personalization configuration:\n${problems}`);
  }

  return result.data;
}
