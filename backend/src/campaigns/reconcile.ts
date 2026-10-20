/**
 * DB-driven reconciliation of generation jobs (spec FR-5 / review fix-up D.2).
 *
 * For drafts with promptVersion = campaign.promptFingerprint that are PENDING,
 * or GENERATING and stale, with no live job:
 *   - looks up job by id
 *   - if completed or failed, removes it and re-adds
 *   - if no job, adds it
 *   - if waiting/active/delayed/prioritized, leaves it alone
 *
 * Callable at boot (reconciling all active campaigns) and on demand (for a specific campaignId).
 */

import type { PrismaClient } from "../generated/prisma/client";
import type { AiConfig } from "../config/ai";
import { config } from "../config";
import { getGenerateQueue, generateJobOptions, GENERATE_JOB_NAME } from "../queue/generateQueue";
import type { GenerateJobData } from "../queue/generateJob";

export const LIVE_JOB_STATES = new Set([
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
]);

export interface EnsureGenerateJobDeps {
  getJob: (
    id: string
  ) => Promise<{ getState: () => Promise<string>; remove: () => Promise<void> } | null | undefined>;
  addJob: (
    name: string,
    data: GenerateJobData,
    options: { jobId: string; attempts: number; backoff: { type: string } }
  ) => Promise<unknown>;
}

export interface EnsureGenerateJobInput {
  draftId: string;
  data: GenerateJobData;
  attempts: number;
}

export type EnsureGenerateJobOutcome = "added" | "skipped_live";

/**
 * Shared helper: look up the job, remove it if completed/failed, skip it if live, else add it.
 * Used by both enqueueGenerate and reconcileGeneration.
 */
export async function ensureGenerateJob(
  input: EnsureGenerateJobInput,
  deps: EnsureGenerateJobDeps
): Promise<EnsureGenerateJobOutcome> {
  const job = await deps.getJob(input.draftId);
  const state = job ? await job.getState() : undefined;

  if (state === "completed" || state === "failed") {
    await job!.remove();
  } else if (state && LIVE_JOB_STATES.has(state)) {
    return "skipped_live";
  }

  await deps.addJob(GENERATE_JOB_NAME, input.data, {
    jobId: input.draftId,
    attempts: input.attempts,
    backoff: { type: "custom" },
  });

  return "added";
}

export interface ReconcileGenerationDeps {
  db?: PrismaClient;
  ai?: AiConfig;
  getJob?: EnsureGenerateJobDeps["getJob"];
  addJob?: EnsureGenerateJobDeps["addJob"];
}

export interface ReconcileGenerationResult {
  reconciledCount: number;
  draftIds: string[];
}

export interface ReconcileSendsDeps {
  db?: PrismaClient;
  clock?: { now: () => Date };
  getJob?: (
    id: string
  ) => Promise<{ getState: () => Promise<string>; remove: () => Promise<void> } | null | undefined>;
  addJob?: (
    name: string,
    data: any,
    options: { delay: number; jobId: string }
  ) => Promise<unknown>;
}

export interface ReconcileSendsResult {
  reconciledCount: number;
  jobIds: string[];
}

/**
 * DB-driven reconciliation of send jobs for SCHEDULED and SENDING campaigns (Phase 6a).
 *
 * For campaigns in SCHEDULED or SENDING, finds EmailJobs linked through drafts that are
 * status pending and have no live job in the send queue (job missing, or completed/failed)
 * and adds the missing job with the right delay = max(0, scheduledAt - now).
 *
 * NEVER touches rows that are rate_limited, sent or failed: the existing send path owns those.
 */
export async function reconcileSends(
  campaignId?: string,
  deps: ReconcileSendsDeps = {}
): Promise<ReconcileSendsResult> {
  const db = deps.db ?? (await import("../db/pool")).prisma;

  let targetCampaignIds: string[] = [];

  if (campaignId) {
    const campaign = await db.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true },
    });
    if (!campaign || (campaign.status !== "SCHEDULED" && campaign.status !== "SENDING")) {
      return { reconciledCount: 0, jobIds: [] };
    }
    targetCampaignIds = [campaign.id];
  } else {
    const campaigns = await db.campaign.findMany({
      where: {
        status: { in: ["SCHEDULED", "SENDING"] },
      },
      select: { id: true },
    });
    targetCampaignIds = campaigns.map((c) => c.id);
  }

  if (targetCampaignIds.length === 0) {
    return { reconciledCount: 0, jobIds: [] };
  }

  // Find EmailJobs linked through drafts that are status pending.
  // Never touch rows that are rate_limited, sent or failed.
  const pendingJobs = await db.emailJob.findMany({
    where: {
      status: "pending",
      generatedDraft: {
        campaignId: { in: targetCampaignIds },
      },
    },
    select: {
      id: true,
      recipientEmail: true,
      subject: true,
      body: true,
      senderEmail: true,
      scheduledAt: true,
    },
  });

  if (pendingJobs.length === 0) {
    return { reconciledCount: 0, jobIds: [] };
  }

  let getJob = deps.getJob;
  let addJob = deps.addJob;

  if (!getJob || !addJob) {
    const { emailQueue } = await import("../queue/queue");
    getJob = getJob ?? ((jobId: string) => emailQueue.getJob(jobId));
    addJob = addJob ?? ((name, data, opts) => emailQueue.add(name, data, opts));
  }

  const now = (deps.clock?.now() ?? new Date()).getTime();
  const reconciledJobIds: string[] = [];

  for (const job of pendingJobs) {
    const existingJob = await getJob(job.id);
    const state = existingJob ? await existingJob.getState() : undefined;

    if (state === "completed" || state === "failed") {
      await existingJob!.remove();
    } else if (state && LIVE_JOB_STATES.has(state)) {
      continue;
    }

    const scheduledAtMs = job.scheduledAt ? new Date(job.scheduledAt).getTime() : now;
    const delayMs = Math.max(0, scheduledAtMs - now);

    await addJob(
      "email-job",
      {
        jobId: job.id,
        recipientEmail: job.recipientEmail,
        subject: job.subject,
        body: job.body,
        senderEmail: job.senderEmail,
      },
      {
        delay: delayMs,
        jobId: job.id,
      }
    );

    reconciledJobIds.push(job.id);
  }

  return { reconciledCount: reconciledJobIds.length, jobIds: reconciledJobIds };
}

export async function reconcileGeneration(
  campaignId?: string,
  deps: ReconcileGenerationDeps = {}
): Promise<ReconcileGenerationResult> {
  const db = deps.db ?? (await import("../db/pool")).prisma;
  const ai = deps.ai ?? config.ai;

  const campaignWhere = campaignId
    ? {
        id: campaignId,
        aiEnabled: true,
        promptFingerprint: { not: null },
        status: { not: "CANCELLED" as const },
      }
    : {
        aiEnabled: true,
        promptFingerprint: { not: null },
        status: { in: ["SAMPLING", "GENERATING"] as ("SAMPLING" | "GENERATING")[] },
      };

  const campaigns = await db.campaign.findMany({
    where: campaignWhere,
  });

  const staleBefore = new Date(Date.now() - 2 * ai.timeoutMs);
  const queue = getGenerateQueue();
  const getJob =
    deps.getJob ??
    (deps.addJob ? async () => undefined : (jobId: string) => queue.getJob(jobId));
  const addJob =
    deps.addJob ??
    (async (name, jobData, opts) => queue.add(name, jobData, opts));

  const draftIds: string[] = [];

  for (const campaign of campaigns) {
    if (!campaign.aiEnabled || !campaign.promptFingerprint) continue;

    const drafts = await db.generatedDraft.findMany({
      where: {
        campaignId: campaign.id,
        promptVersion: campaign.promptFingerprint,
        OR: [
          { status: "PENDING" },
          { status: "GENERATING", updatedAt: { lt: staleBefore } },
        ],
      },
    });

    for (const draft of drafts) {
      const data: GenerateJobData = {
        draftId: draft.id,
        campaignId: campaign.id,
        recipientId: draft.recipientId,
        isSample: draft.isSample,
      };
      const jobOptions = generateJobOptions(1 + ai.maxRetries);

      const outcome = await ensureGenerateJob(
        { draftId: draft.id, data, attempts: jobOptions.attempts as number },
        { getJob, addJob }
      );

      if (outcome === "skipped_live") {
        continue;
      }

      if (draft.status === "GENERATING") {
        await db.generatedDraft.update({
          where: { id: draft.id },
          data: { status: "PENDING" },
        });
      }

      draftIds.push(draft.id);
    }
  }

  return { reconciledCount: draftIds.length, draftIds };
}
