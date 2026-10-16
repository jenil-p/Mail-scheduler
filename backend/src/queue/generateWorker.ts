/**
 * Generate worker (spec FR-5…FR-10, decision A3, NFR-5).
 *
 * One job = one draft. The order of the checks is the important part, because
 * every one of them exists to avoid paying for a model call:
 *
 *   1. a job payload from an unknown code version is terminal, not retried;
 *   2. a draft in a terminal state returns immediately (FR-7) — this is what makes
 *      a re-delivered job and a restarted worker free;
 *   3. a cancelled, paused or missing campaign is skipped;
 *   4. a prompt-version mismatch **pauses** the campaign and generates nothing
 *      (Phase 1 review note) — the prompt is part of the draft identity, so
 *      generating here would produce drafts nobody can account for;
 *   5. a recipient without personalization data falls back with `THIN_DATA`
 *      before any call (FR-4);
 *   6. only then is the draft claimed, with a status precondition so two workers
 *      racing one draft produce exactly one model call (6.4).
 *
 * Failures are classified once, here, into the three outcomes a draft can have:
 * retry (throw and let BullMQ's attempts/backoff do the waiting), rate-limit the
 * whole queue (a 429 that arrives with a delay), or fall back (terminal). There is
 * no retry loop inside the processor: BullMQ owns the waiting, so a crash mid-job
 * cannot hold a slot.
 */

import { RateLimitError, UnrecoverableError, Worker, type Job } from "bullmq";
import { config } from "../config";
import type { AiConfig } from "../config/ai";
import { prisma as defaultPrisma } from "../db/pool";
import type { PrismaClient } from "../generated/prisma/client";
import { createLlmClient } from "../ai/llm";
import {
  LlmError,
  NonRetryableError,
  QuotaExhaustedError,
  RetryableError,
  introSchema,
  type LlmClient,
} from "../ai/llm/LlmClient";
import { createJitteredBackoffStrategy } from "../ai/llm/backoff";
import { buildPersonalizePrompt, EMAIL_PURPOSE_MAX_CHARS, PROMPT_VERSION } from "../ai/prompts/personalize.v1";
import { LlmLimiter } from "../ai/rateLimit/llmLimiter";
import { safeErrorLog } from "../ai/safeLog";
import { renderCampaignEmail } from "../campaigns/values";
import { normalizeNewlines } from "../campaigns/render";
import { GENERATE_QUEUE_NAME, getGenerateQueue } from "./generateQueue";
import { isGenerateJobData, type GenerateJobData } from "./generateJob";
import { redisConnection } from "./queue";
import Redis from "ioredis";

/** Fallback reasons stored on the draft (FR-10 and the 429 decision). */
export const FALLBACK_THIN_DATA = "THIN_DATA";
export const FALLBACK_QUOTA_EXHAUSTED = "QUOTA_EXHAUSTED";

/** Draft statuses that mean "generation is over for this draft" (FR-7). */
export const TERMINAL_DRAFT_STATUSES = [
  "READY",
  "FLAGGED",
  "FALLBACK",
  "APPROVED",
  "HELD",
  "QUEUED",
] as const;

export type GenerateOutcome =
  | "READY"
  | "FALLBACK"
  | "MISSING"
  | "SKIPPED_TERMINAL"
  | "SKIPPED_CAMPAIGN"
  | "SKIPPED_NOT_CLAIMED"
  | "PAUSED_VERSION_MISMATCH";

export interface GenerateResult {
  outcome: GenerateOutcome;
  /** Set for FALLBACK outcomes: `THIN_DATA`, `QUOTA_EXHAUSTED` or an error code. */
  fallbackReason?: string;
}

/** The parts of a BullMQ job this processor uses — so tests can pass a plain object. */
export interface GenerateJobLike {
  id?: string;
  data: unknown;
  attemptsMade: number;
  opts: { attempts?: number };
}

export interface GenerateDeps {
  prisma: PrismaClient;
  llm: LlmClient;
  limiter: LlmLimiter;
  ai: AiConfig;
  /** Defaults to `queue.rateLimit`, for tests that do not want Redis here. */
  rateLimit?: (expireTimeMs: number) => Promise<void>;
  log?: (message: string) => void;
}

function noop(): void {}

function defaultLog(message: string): void {
  console.log(`[Generate] ${message}`);
}

function isTerminal(status: string): boolean {
  return (TERMINAL_DRAFT_STATUSES as readonly string[]).includes(status);
}

/** The rendered plain template: no intro, so the `{{ai_intro}}` line disappears. */
function renderPlain(draft: DraftWithRelations, aiIntro?: string) {
  return renderCampaignEmail({
    subjectTemplate: draft.campaign.subjectTemplate,
    bodyTemplate: draft.campaign.bodyTemplate,
    recipient: {
      firstName: draft.recipient.firstName,
      company: draft.recipient.company,
      role: draft.recipient.role,
      note: draft.recipient.note,
      extra: (draft.recipient.extra ?? undefined) as Record<string, unknown> | undefined,
    },
    campaign: {
      linkUrl: draft.campaign.linkUrl,
      unsubscribeUrl: draft.campaign.unsubscribeUrl,
    },
    aiIntro,
  });
}

/**
 * The template without its AI slot, as the model's context for the email's
 * purpose. Placeholders are left unresolved on purpose: substituting them would
 * send more recipient text than the prompt needs, and the structured fields are
 * already in the `<recipient_data>` block.
 */
export function emailPurposeFrom(bodyTemplate: string): string {
  return normalizeNewlines(bodyTemplate)
    .replace(/\{\{\s*ai_intro\s*\}\}/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EMAIL_PURPOSE_MAX_CHARS);
}

/** FR-6: the output is JSON validated with Zod; anything else is a parse failure. */
export function parseIntro(text: string): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RetryableError("Provider returned output that is not valid JSON", {
      code: "MALFORMED_JSON",
    });
  }

  const result = introSchema.safeParse(parsed);

  if (!result.success) {
    throw new RetryableError("Provider output did not match { intro: string }", {
      code: "MALFORMED_JSON",
    });
  }

  return result.data.intro;
}

type DraftWithRelations = {
  id: string;
  campaignId: string;
  recipientId: string;
  status: string;
  promptVersion: string;
  rateLimitHits: number;
  campaign: {
    id: string;
    status: string;
    subjectTemplate: string;
    bodyTemplate: string;
    linkUrl: string;
    unsubscribeUrl: string;
    aiInstruction: string | null;
    promptFingerprint: string | null;
    promptTemplateVersion: string | null;
  };
  recipient: {
    id: string;
    campaignId: string;
    firstName: string | null;
    company: string | null;
    role: string | null;
    note: string | null;
    extra: unknown;
    hasPersonalizationData: boolean;
  };
};

/**
 * The whole processor. Returns a description of what happened for logs/tests;
 * throws when BullMQ should retry, throttle or stop.
 */
export async function processGenerate(
  deps: GenerateDeps,
  job: GenerateJobLike
): Promise<GenerateResult> {
  const log = deps.log ?? defaultLog;

  if (!isGenerateJobData(job.data)) {
    // Something else wrote this job. Retrying cannot fix a foreign payload.
    throw new UnrecoverableError("Generate job payload is not in a shape this version understands");
  }

  const { draftId } = job.data as GenerateJobData;

  const draft = (await deps.prisma.generatedDraft.findUnique({
    where: { id: draftId },
    include: { campaign: true, recipient: true },
  })) as DraftWithRelations | null;

  if (!draft) {
    // The campaign (and with it the draft) was deleted. Nothing to do, and
    // nothing to retry.
    log(`draft ${draftId} no longer exists, skipping`);
    return { outcome: "MISSING" };
  }

  // 2. Already resolved: return the stored result without a model call (FR-7).
  if (isTerminal(draft.status)) {
    log(`draft ${draftId} is ${draft.status}, no generation needed`);
    return { outcome: "SKIPPED_TERMINAL" };
  }

  // 3. Cancelled or paused campaigns generate nothing.
  if (draft.campaign.status === "CANCELLED" || draft.campaign.status === "PAUSED") {
    log(`campaign ${draft.campaignId} is ${draft.campaign.status}, skipping draft ${draftId}`);
    return { outcome: "SKIPPED_CAMPAIGN" };
  }

  // 4. The frozen prompt identity must match this build (Phase 1 review note).
  if (draft.campaign.promptTemplateVersion !== PROMPT_VERSION) {
    await pauseForPromptVersionMismatch(deps, draft);
    log(
      `campaign ${draft.campaignId} was frozen with prompt ${draft.campaign.promptTemplateVersion ?? "(none)"}, ` +
        `this build runs ${PROMPT_VERSION} — paused, no generation`
    );
    return { outcome: "PAUSED_VERSION_MISMATCH" };
  }

  // 5. Thin data never reaches the provider (FR-4).
  if (!draft.recipient.hasPersonalizationData) {
    const rendered = renderPlain(draft);
    await deps.prisma.generatedDraft.update({
      where: { id: draft.id },
      data: {
        status: "FALLBACK",
        fallbackReason: FALLBACK_THIN_DATA,
        aiIntro: null,
        subject: rendered.subject,
        body: rendered.body,
      },
    });

    log(`draft ${draftId}: no personalization data, fell back to the plain template`);
    return { outcome: "FALLBACK", fallbackReason: FALLBACK_THIN_DATA };
  }

  // 6. Claim it. Two workers racing one draft: only one updateMany matches.
  const staleBefore = new Date(Date.now() - 2 * deps.ai.timeoutMs);
  const claim = await deps.prisma.generatedDraft.updateMany({
    where: {
      id: draft.id,
      OR: [{ status: "PENDING" }, { status: "GENERATING", updatedAt: { lt: staleBefore } }],
    },
    data: { status: "GENERATING", attempts: { increment: 1 } },
  });

  if (claim.count === 0) {
    log(`draft ${draftId} is already being generated elsewhere`);
    return { outcome: "SKIPPED_NOT_CLAIMED" };
  }

  const maxAttempts = job.opts.attempts ?? 1 + deps.ai.maxRetries;
  const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;

  try {
    return await generate(deps, draft, log);
  } catch (error) {
    if (error instanceof RateLimitError) throw error;

    return await fail(deps, draft, error, { isLastAttempt, job, log });
  }
}

/**
 * The model call itself, after every skip/fallback check has passed.
 *
 * Order: local limit → provider → parse → render → store. Rendering goes through
 * `renderCampaignEmail`, the only rendering entry point, so model output can never
 * be placed into the body unescaped or into a reserved variable.
 */
async function generate(
  deps: GenerateDeps,
  draft: DraftWithRelations,
  log: (message: string) => void
): Promise<GenerateResult> {
  const provider = deps.ai.provider;
  const model = deps.llm.model;

  const limit = await deps.limiter.tryAcquire(provider, model);

  if (limit.status === "rate_limited") {
    await throttle(deps, draft, limit.retryAfterMs, () =>
      new RateLimitError(`LLM per-minute limit reached for ${provider}/${model}`)
    );
  }

  if (limit.status === "quota_exhausted") {
    await fallBackForQuota(deps, draft, log, "local daily cap reached");
    return { outcome: "FALLBACK", fallbackReason: FALLBACK_QUOTA_EXHAUSTED };
  }

  const prompt = buildPersonalizePrompt({
    aiInstruction: draft.campaign.aiInstruction ?? "",
    emailPurpose: emailPurposeFrom(draft.campaign.bodyTemplate),
    recipient: {
      first_name: draft.recipient.firstName,
      company: draft.recipient.company,
      role: draft.recipient.role,
      note: draft.recipient.note,
    },
  });

  const startedAt = Date.now();
  const result = await deps.llm.generateJson({
    ...prompt,
    maxTokens: deps.ai.maxOutputTokens,
    timeoutMs: deps.ai.timeoutMs,
  });
  const latencyMs = Date.now() - startedAt;

  const intro = parseIntro(result.text);

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 4 hook: deterministic guardrails.
  //
  // Phase 4 replaces this comment with `runGuardrails({ intro, recipient,
  // renderedBody })`. A failing check makes the draft `FLAGGED` with
  // machine-readable `flagReasons` instead of `READY`, and the same runner is
  // re-run when a reviewer edits an intro (FR-12). Until it exists, every parsed
  // intro is `READY`.
  // ───────────────────────────────────────────────────────────────────────────

  const rendered = renderPlain(draft, intro);

  await deps.prisma.generatedDraft.update({
    where: { id: draft.id },
    data: {
      status: "READY",
      aiIntro: intro,
      subject: rendered.subject,
      body: rendered.body,
      fallbackReason: null,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs,
    },
  });

  log(
    `draft ${draft.id} READY (${result.model}, ${result.tokensIn}+${result.tokensOut} tokens, ${latencyMs}ms)`
  );

  return { outcome: "READY" };
}

/**
 * Decide what a failed attempt means for the draft.
 *
 * - terminal (non-retryable, quota, or the last attempt): the draft becomes
 *   `FALLBACK` with the error code stored (FR-10) and the job does not retry;
 * - per-minute 429: the whole queue is rate-limited for the announced delay and
 *   the job goes back to wait **without consuming an attempt** (FR-8) — bounded by
 *   `LLM_MAX_RETRIES` hops, after which it is treated as a normal failure so a
 *   permanently throttled provider still terminates;
 * - anything else retryable: the claim is released back to `PENDING` and the error
 *   is rethrown for BullMQ to retry with the custom backoff.
 */
async function fail(
  deps: GenerateDeps,
  draft: DraftWithRelations,
  error: unknown,
  context: { isLastAttempt: boolean; job: GenerateJobLike; log: (message: string) => void }
): Promise<GenerateResult> {
  const { isLastAttempt, job, log } = context;
  const code = error instanceof LlmError ? error.code : "UNKNOWN";

  log(`draft ${draft.id} attempt ${job.attemptsMade + 1} failed: ${safeErrorLog(error)}`);

  if (error instanceof QuotaExhaustedError) {
    await fallBackForQuota(deps, draft, log, "provider reported the daily quota is exhausted");
    return { outcome: "FALLBACK", fallbackReason: FALLBACK_QUOTA_EXHAUSTED };
  }

  // 401/403 is not the draft's fault: pause the campaign so the operator sees it
  // instead of watching every remaining draft fall back one by one.
  if (error instanceof NonRetryableError && error.authFailure) {
    await pauseForAuthFailure(deps, draft);
  }

  const terminal = error instanceof NonRetryableError || isLastAttempt || !isRetryable(error);

  if (terminal) {
    await fallBackWithReason(deps, draft, code);
    log(`draft ${draft.id} fell back to the plain template (${code})`);

    if (error instanceof NonRetryableError) {
      // No retries for 400/401/403: mark the job terminal rather than letting it
      // burn the remaining attempts on the same permanent error.
      throw new UnrecoverableError(`Generate failed permanently: ${code}`);
    }

    return { outcome: "FALLBACK", fallbackReason: code };
  }

  const retryable = error as RetryableError;

  if (retryable.code === "MALFORMED_JSON" && job.attemptsMade >= deps.ai.maxParseRetries) {
    await fallBackWithReason(deps, draft, retryable.code);
    log(`draft ${draft.id} fell back after ${job.attemptsMade} malformed responses`);
    return { outcome: "FALLBACK", fallbackReason: retryable.code };
  }

  if (retryable.code === "RATE_LIMITED_PER_MINUTE" || retryable.code === "RATE_LIMITED_TOKEN") {
    await throttle(
      deps,
      draft,
      retryable.retryAfterMs ?? delayForAttempt(deps, job.attemptsMade),
      () => retryable
    );
  }

  // Release the claim so the retry can take it again, then let BullMQ wait.
  await deps.prisma.generatedDraft.updateMany({
    where: { id: draft.id, status: "GENERATING" },
    data: { status: "PENDING" },
  });

  throw error;
}

function isRetryable(error: unknown): boolean {
  return error instanceof RetryableError;
}

function delayForAttempt(deps: GenerateDeps, attemptsMade: number): number {
  return createJitteredBackoffStrategy({
    baseMs: deps.ai.retryBackoffBaseMs,
    maxMs: deps.ai.retryBackoffMaxMs,
  })(attemptsMade);
}

/**
 * Hand the delay to the queue and go back to wait.
 *
 * `RateLimitError` moves the job back to `wait` without incrementing its attempt
 * count, so an endlessly throttled provider could otherwise keep one job alive
 * forever. The number of observed 429s is recorded on the draft (the `rateLimitHits`
 * metric, FR-16) and used as that bound: past `LLM_MAX_RETRIES` hops the caller's
 * original error is rethrown instead, which consumes an attempt and ends in a
 * fallback rather than an unbounded loop.
 */
async function throttle(
  deps: GenerateDeps,
  draft: DraftWithRelations,
  retryAfterMs: number,
  original: () => Error
): Promise<never> {
  const updated = await deps.prisma.generatedDraft.update({
    where: { id: draft.id },
    data: { status: "PENDING", rateLimitHits: { increment: 1 } },
  });

  if (updated.rateLimitHits > deps.ai.maxRetries) {
    throw original();
  }

  const delay = Math.max(0, Math.round(retryAfterMs));

  // `queue.rateLimit` (not the deprecated `worker.rateLimit`) sets the queue-wide
  // limiter key, so every worker pauses for the announced delay.
  await deps.rateLimit?.(delay);

  throw new RateLimitError(`LLM rate limited, retrying in ${delay}ms`);
}

async function fallBackWithReason(
  deps: GenerateDeps,
  draft: DraftWithRelations,
  reason: string
): Promise<void> {
  const rendered = renderPlain(draft);

  await deps.prisma.generatedDraft.updateMany({
    where: { id: draft.id, status: "GENERATING" },
    data: {
      status: "FALLBACK",
      fallbackReason: reason,
      aiIntro: null,
      subject: rendered.subject,
      body: rendered.body,
    },
  });
}

/**
 * The daily quota is gone: fall this draft back, stop the campaign's remaining
 * drafts before they call the provider, and leave a visible notice — but do **not**
 * pause the campaign (the quota is temporary and the user's schedule is not).
 */
async function fallBackForQuota(
  deps: GenerateDeps,
  draft: DraftWithRelations,
  log: (message: string) => void,
  trigger: string,
): Promise<void> {
  await fallBackWithReason(deps, draft, FALLBACK_QUOTA_EXHAUSTED);
  log(`draft ${draft.id} fell back: daily quota exhausted (${trigger})`);

  const remaining = await deps.prisma.generatedDraft.findMany({
    where: {
      campaignId: draft.campaignId,
      promptVersion: draft.promptVersion,
      status: "PENDING",
      id: { not: draft.id },
    },
    include: { campaign: true, recipient: true },
  });

  let shortCircuited = 0;

  for (const pending of remaining as DraftWithRelations[]) {
    const rendered = renderPlain(pending);

    const { count } = await deps.prisma.generatedDraft.updateMany({
      where: { id: pending.id, status: "PENDING" },
      data: {
        status: "FALLBACK",
        fallbackReason: FALLBACK_QUOTA_EXHAUSTED,
        aiIntro: null,
        subject: rendered.subject,
        body: rendered.body,
      },
    });

    shortCircuited += count;
  }

  const total = shortCircuited + 1;

  await deps.prisma.campaign.update({
    where: { id: draft.campaignId },
    data: {
      errorMessage:
        `The AI provider's daily quota is exhausted (${trigger}). ${total} draft(s) of this campaign ` +
        "were prepared with the plain template and no AI intro. Generation continues automatically " +
        "once the quota resets, or earlier if you raise LLM_RATE_LIMIT_PER_DAY.",
    },
  });

  log(
    `campaign ${draft.campaignId}: ${shortCircuited} pending draft(s) short-circuited to FALLBACK after the quota ran out`
  );
}

/** FR-9: a rejected API key pauses the campaign, with the reason on the campaign. */
async function pauseForAuthFailure(deps: GenerateDeps, draft: DraftWithRelations): Promise<void> {
  await deps.prisma.campaign.updateMany({
    where: { id: draft.campaignId },
    data: {
      status: "PAUSED",
      errorMessage:
        "Generation is paused: the AI provider rejected the API key (HTTP 401/403). " +
        "Check LLM_API_KEY, then resume the campaign.",
    },
  });

  const rendered = renderPlain(draft);

  await deps.prisma.generatedDraft.updateMany({
    where: { id: draft.id, status: "GENERATING" },
    data: {
      status: "FALLBACK",
      fallbackReason: "AUTH_FAILURE",
      aiIntro: null,
      subject: rendered.subject,
      body: rendered.body,
    },
  });
}

/** The Phase 1 review rule: a prompt-version mismatch pauses, it does not generate. */
async function pauseForPromptVersionMismatch(
  deps: GenerateDeps,
  draft: DraftWithRelations
): Promise<void> {
  await deps.prisma.campaign.updateMany({
    where: { id: draft.campaignId, status: { not: "PAUSED" } },
    data: {
      status: "PAUSED",
      errorMessage:
        `Generation is paused: this campaign was created with prompt version ` +
        `"${draft.campaign.promptTemplateVersion ?? "unknown"}", but the server now runs ` +
        `"${PROMPT_VERSION}". Regenerate the samples to continue.`,
    },
  });
}

export interface CreateGenerateWorkerDeps {
  prisma?: PrismaClient;
  llm?: LlmClient;
  limiter?: LlmLimiter;
  ai?: AiConfig;
  /** Redis used for the provider limiter; defaults to the app's Redis config. */
  redis?: Redis;
  rateLimit?: (expireTimeMs: number) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * Start the generate worker. Called from `src/index.ts` **only** when
 * `AI_PERSONALIZATION_ENABLED` is true, so with the flag off nothing new runs.
 */
export function createGenerateWorker(deps: CreateGenerateWorkerDeps = {}): Worker<GenerateJobData> {
  const ai = deps.ai ?? config.ai;
  const prisma = deps.prisma ?? defaultPrisma;
  const llm = deps.llm ?? createLlmClient(ai);

  const redis =
    deps.redis ??
    new Redis({ host: config.redis.host, port: config.redis.port, maxRetriesPerRequest: null });

  const limiter =
    deps.limiter ??
    new LlmLimiter(redis, {
      perMinute: ai.rateLimitPerMin,
      dailyLimit: ai.dailyRateLimit,
      resetTimeZone: ai.dailyResetTz,
    });

  const queue = getGenerateQueue();

  const workerDeps: GenerateDeps = {
    prisma,
    llm,
    limiter,
    ai,
    rateLimit: deps.rateLimit ?? ((ms) => queue.rateLimit(ms)),
    log: deps.log ?? defaultLog,
  };

  const worker = new Worker<GenerateJobData>(
    GENERATE_QUEUE_NAME,
    async (job: Job<GenerateJobData>) => processGenerate(workerDeps, job),
    {
      connection: redisConnection,
      concurrency: ai.generateConcurrency,
      settings: {
        // Jittered exponential backoff, generate queue only (decision A3).
        backoffStrategy: createJitteredBackoffStrategy({
          baseMs: ai.retryBackoffBaseMs,
          maxMs: ai.retryBackoffMaxMs,
        }),
      },
    }
  );

  worker.on("ready", () => {
    console.log(
      `[Generate] worker ready — concurrency ${ai.generateConcurrency}, ` +
        `${ai.provider}/${llm.model}, attempts ${1 + ai.maxRetries}`
    );
  });

  worker.on("failed", (job, error) => {
    // Ids and codes only: never a recipient address or prompt text (NFR-4).
    console.error(`[Generate] job ${job?.id ?? "(unknown)"} failed: ${safeErrorLog(error)}`);
  });

  worker.on("error", (error) => {
    console.error(`[Generate] worker error: ${safeErrorLog(error)}`);
  });

  return worker;
}
