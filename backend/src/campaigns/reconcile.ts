/**
 * DB-driven reconciliation of generation jobs (spec FR-5 / review fix-up D.2).
 *
 * For drafts with promptVersion = campaign.promptFingerprint that are PENDING,
 * or GENERATING and stale, with no live job:
 *   - looks up job by id
 *   - if completed or failed, removes it and re-adds
 *   - if no job, adds it
 *   - if waiting/active/delayed, leaves it alone
 *
 * Callable at boot (reconciling all active campaigns) and on demand (for a specific campaignId).
 */

import type { PrismaClient } from "../generated/prisma/client";
import type { AiConfig } from "../config/ai";
import { config } from "../config";
import { getGenerateQueue, generateJobOptions, GENERATE_JOB_NAME } from "../queue/generateQueue";
import type { GenerateJobData } from "../queue/generateJob";
import type { EnqueueGenerateDeps } from "./enqueue";

export interface ReconcileGenerationDeps {
  db?: PrismaClient;
  ai?: AiConfig;
  getJob?: EnqueueGenerateDeps["getJob"];
  addJob?: EnqueueGenerateDeps["addJob"];
}

export interface ReconcileGenerationResult {
  reconciledCount: number;
  draftIds: string[];
}

export async function reconcileGeneration(
  campaignId?: string,
  deps: ReconcileGenerationDeps = {}
): Promise<ReconcileGenerationResult> {
  const db = deps.db ?? (await import("../db/pool")).prisma;
  const ai = deps.ai ?? config.ai;

  const campaignWhere = campaignId
    ? { id: campaignId }
    : {
        aiEnabled: true,
        promptFingerprint: { not: null },
        status: { notIn: ["CANCELLED"] as ("CANCELLED")[] },
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
      const job = await getJob(draft.id);
      const state = job ? await job.getState() : undefined;

      if (state === "completed" || state === "failed") {
        await job!.remove();
      } else if (
        state === "waiting" ||
        state === "active" ||
        state === "delayed" ||
        state === "prioritized" ||
        state === "waiting-children"
      ) {
        // live job: leave it alone
        continue;
      }

      if (draft.status === "GENERATING") {
        await db.generatedDraft.update({
          where: { id: draft.id },
          data: { status: "PENDING" },
        });
      }

      const data: GenerateJobData = {
        draftId: draft.id,
        campaignId: campaign.id,
        recipientId: draft.recipientId,
        isSample: draft.isSample,
      };
      const jobOptions = generateJobOptions(1 + ai.maxRetries);

      await addJob(GENERATE_JOB_NAME, data, {
        jobId: draft.id,
        attempts: jobOptions.attempts as number,
        backoff: { type: "custom" },
      });

      draftIds.push(draft.id);
    }
  }

  return { reconciledCount: draftIds.length, draftIds };
}
