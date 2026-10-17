/**
 * `enqueueGenerate(campaignId, recipientId, { isSample })` — the only way a draft
 * enters the generate queue (spec 6.4 idempotency, FR-7).
 *
 * Two guarantees, both from the deterministic identity:
 *
 * - the draft id is `sha256(campaignId|recipientId|templateHash|promptFingerprint)`,
 *   so the same campaign+recipient+template+prompt always maps to the same row;
 * - the BullMQ job id is that same id, so adding the job twice cannot create a
 *   second job.
 *
 * The upsert deliberately uses an **empty** `update`: re-adding must not reset a
 * draft that is already `READY`/`FLAGGED`/`FALLBACK`, and it must not clear an
 * `APPROVED` flag a reviewer set. Only a row that does not exist yet is created.
 *
 * `promptVersion` is the campaign's **stored** `promptFingerprint` (never the
 * running process's env), so a campaign frozen under one prompt keeps its own
 * identity even if the server is restarted with different LLM settings.
 */

import type { PrismaClient } from "../generated/prisma/client";
import type { AiConfig } from "../config/ai";
import { config } from "../config";
import { campaignPromptIdentity, draftId as computeDraftId } from "../ai/identity";
import { getGenerateQueue, generateJobOptions } from "../queue/generateQueue";
import type { GenerateJobData } from "../queue/generateJob";
import { ensureGenerateJob } from "./reconcile";

export class CampaignNotEnqueueableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignNotEnqueueableError";
  }
}

export interface EnqueueGenerateOptions {
  isSample?: boolean;
}

/** Injectable for tests; production uses the shared client and the real queue. */
export interface EnqueueGenerateDeps {
  db?: PrismaClient;
  /**
   * Config the attempt budget comes from. The worker reads the same value from
   * `job.opts.attempts`, so both sides must agree on it — production always uses
   * the process config, and a test that runs the worker with its own config must
   * pass the same one here or the two will disagree about "the last attempt".
   */
  ai?: AiConfig;
  getJob?: (
    id: string
  ) => Promise<{ getState: () => Promise<string>; remove: () => Promise<void> } | null | undefined>;
  addJob?: (
    name: string,
    data: GenerateJobData,
    options: { jobId: string; attempts: number; backoff: { type: string } }
  ) => Promise<unknown>;
}

export interface EnqueueGenerateResult {
  draftId: string;
  campaignId: string;
  recipientId: string;
  isSample: boolean;
}

const TERMINAL_STATUSES = new Set([
  "READY",
  "FLAGGED",
  "FALLBACK",
  "APPROVED",
  "HELD",
  "QUEUED",
]);

/**
 * Create (or leave alone) the draft for one recipient and put its job on the
 * generate queue. Re-calling it for the same pair is a no-op.
 */
export async function enqueueGenerate(
  campaignId: string,
  recipientId: string,
  options: EnqueueGenerateOptions = {},
  deps: EnqueueGenerateDeps = {}
): Promise<EnqueueGenerateResult> {
  const db = deps.db ?? (await import("../db/pool")).prisma;

  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) {
    throw new CampaignNotEnqueueableError(`Campaign ${campaignId} does not exist`);
  }

  if (!campaign.aiEnabled) {
    throw new CampaignNotEnqueueableError(
      `Campaign ${campaignId} has AI personalization disabled, so it has no drafts`
    );
  }

  // Throws CampaignPromptIdentityMissingError when sampling never started.
  const identity = campaignPromptIdentity(campaign);

  const recipient = await db.recipient.findUnique({ where: { id: recipientId } });
  if (!recipient || recipient.campaignId !== campaignId) {
    throw new CampaignNotEnqueueableError(
      `Recipient ${recipientId} does not belong to campaign ${campaignId}`
    );
  }

  const isSample = options.isSample ?? false;

  const id = computeDraftId({
    campaignId,
    recipientId,
    templateHash: campaign.templateHash,
    promptFingerprint: identity.promptFingerprint,
  });

  const draft = await db.generatedDraft.upsert({
    where: { id },
    create: {
      id,
      campaignId,
      recipientId,
      isSample,
      status: "PENDING",
      // The rendered subject/body are written by the worker when the draft
      // resolves; a PENDING draft has nothing to send yet.
      subject: "",
      body: "",
      promptVersion: identity.promptFingerprint,
    },
    update: {},
  });

  // After the upsert, if the draft is terminal, do not add a job.
  if (TERMINAL_STATUSES.has(draft.status)) {
    return { draftId: id, campaignId, recipientId, isSample };
  }

  const queue = getGenerateQueue();
  const getJob =
    deps.getJob ??
    (deps.addJob ? async () => undefined : (jobId: string) => queue.getJob(jobId));
  const addJob =
    deps.addJob ??
    (async (name, jobData, opts) => queue.add(name, jobData, opts));

  const data: GenerateJobData = { draftId: id, campaignId, recipientId, isSample };
  const jobOptions = generateJobOptions(1 + (deps.ai?.maxRetries ?? config.ai.maxRetries));

  await ensureGenerateJob(
    { draftId: id, data, attempts: jobOptions.attempts as number },
    { getJob, addJob }
  );

  return { draftId: id, campaignId, recipientId, isSample };
}

/**
 * Fan out generation for a set of recipients. Sequential on purpose: this runs in
 * a request/worker context and the queue is the thing that provides throughput.
 */
export async function enqueueGenerateForRecipients(
  campaignId: string,
  recipientIds: readonly string[],
  options: EnqueueGenerateOptions = {},
  deps: EnqueueGenerateDeps = {}
): Promise<EnqueueGenerateResult[]> {
  const results: EnqueueGenerateResult[] = [];

  for (const recipientId of recipientIds) {
    results.push(await enqueueGenerate(campaignId, recipientId, options, deps));
  }

  return results;
}

export {
  ensureGenerateJob,
  reconcileGeneration,
  type EnsureGenerateJobDeps,
  type EnsureGenerateJobInput,
  type EnsureGenerateJobOutcome,
  type ReconcileGenerationDeps,
  type ReconcileGenerationResult,
} from "./reconcile";
