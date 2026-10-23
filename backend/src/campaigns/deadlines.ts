/**
 * Deadline enforcement for campaigns (Phase 6b).
 *
 * Runs during the background tick before refreshCampaign.
 * deadline = campaign.scheduledAt - ai.finalizeLeadMs.
 *
 * For campaigns with now >= deadline:
 * a. SAMPLING, SAMPLE_REVIEW, PAUSED: transition to CANCELLED with
 *    errorMessage: "The scheduled time passed before this campaign was ready, so nothing was sent."
 * b. GENERATING: drafts still PENDING or GENERATING are resolved per onUnresolved:
 *    - FALLBACK_TO_PLAIN -> FALLBACK (plain render via renderCampaignEmail,
 *      fallbackReason: GENERATION_INCOMPLETE_AT_DEADLINE, resolvedBy: SYSTEM, aiIntro: null).
 *    - HOLD -> HELD (resolvedBy: SYSTEM).
 *    Uses updateMany with status preconditions so concurrent resolutions are not touched.
 *    Then handles FLAGGED drafts as in c.
 * c. EXCEPTION_REVIEW (and FLAGGED drafts from b): FLAGGED drafts are resolved per onUnresolved:
 *    - FALLBACK_TO_PLAIN -> FALLBACK (plain render via renderCampaignEmail,
 *      fallbackReason: UNRESOLVED_AT_DEADLINE, resolvedBy: SYSTEM, keep flagReasons for audit).
 *    - HOLD -> HELD (resolvedBy: SYSTEM).
 *
 * After a, b, or c calls refreshCampaign.
 * Drafts are processed in chunks of 50, each in a short transaction.
 * Logs IDs and counts only.
 */

import type { PrismaClient, CampaignStatus } from "../generated/prisma/client";
import type { AiConfig } from "../config/ai";
import { config } from "../config";
import { transition } from "./stateMachine";
import { renderCampaignEmail } from "./values";
import { refreshCampaign } from "./flow";

export interface EnforceDeadlinesDeps {
  db?: PrismaClient;
  clock?: { now: () => Date };
  ai?: AiConfig;
  logger?: {
    info?: (message: string) => void;
    error: (message: string) => void;
  };
  refresh?: typeof refreshCampaign;
}

export interface EnforceDeadlinesResult {
  processedCampaigns: number;
  cancelledCampaigns: number;
  resolvedDrafts: number;
}

const DEADLINE_CHUNK_SIZE = 50;

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

export interface CandidateCampaignForDeadline {
  id: string;
  status: CampaignStatus;
  scheduledAt: Date;
  onUnresolved: string;
  promptFingerprint: string | null;
  subjectTemplate: string;
  bodyTemplate: string;
  linkUrl: string;
  unsubscribeUrl: string;
}

/**
 * Shared helper to resolve unfinished drafts for a campaign at deadline (spec Phase 6b).
 */
export async function resolveUnfinished(
  db: PrismaClient,
  campaign: CandidateCampaignForDeadline,
  fromStatuses: string[],
  plainReason: string,
  chunkSize = DEADLINE_CHUNK_SIZE
): Promise<number> {
  if (!campaign.promptFingerprint) return 0;

  const drafts = await db.generatedDraft.findMany({
    where: {
      campaignId: campaign.id,
      promptVersion: campaign.promptFingerprint,
      status: { in: fromStatuses as any },
    },
    include: {
      recipient: true,
    },
  });

  let resolvedCount = 0;
  const chunks = chunkArray(drafts, chunkSize);

  for (const chunk of chunks) {
    await db.$transaction(async (tx: any) => {
      if (campaign.onUnresolved === "HOLD") {
        const res = await tx.generatedDraft.updateMany({
          where: {
            id: { in: chunk.map((d) => d.id) },
            status: { in: fromStatuses as any },
          },
          data: {
            status: "HELD",
            resolvedBy: "SYSTEM",
          },
        });
        resolvedCount += res.count;
      } else {
        // FALLBACK_TO_PLAIN
        for (const draft of chunk) {
          const rendered = renderCampaignEmail({
            subjectTemplate: campaign.subjectTemplate,
            bodyTemplate: campaign.bodyTemplate,
            recipient: {
              firstName: draft.recipient?.firstName,
              company: draft.recipient?.company,
              role: draft.recipient?.role,
              note: draft.recipient?.note,
              extra: (draft.recipient?.extra ?? undefined) as
                | Record<string, unknown>
                | undefined,
            },
            campaign,
            aiIntro: undefined,
          });

          const res = await tx.generatedDraft.updateMany({
            where: {
              id: draft.id,
              status: { in: fromStatuses as any },
            },
            data: {
              status: "FALLBACK",
              fallbackReason: plainReason,
              resolvedBy: "SYSTEM",
              aiIntro: null,
              subject: rendered.subject,
              body: rendered.body,
            },
          });
          resolvedCount += res.count;
        }
      }
    });
  }

  return resolvedCount;
}

export async function enforceDeadlines(
  deps: EnforceDeadlinesDeps = {}
): Promise<EnforceDeadlinesResult> {
  const db = deps.db ?? (await import("../db/pool")).prisma;
  const ai = deps.ai ?? config.ai;
  const now = (deps.clock ? deps.clock.now() : new Date()).getTime();
  const logger = deps.logger ?? console;
  const refresh = deps.refresh ?? refreshCampaign;

  const targetStatuses: CampaignStatus[] = [
    "SAMPLING",
    "SAMPLE_REVIEW",
    "PAUSED",
    "GENERATING",
    "EXCEPTION_REVIEW",
  ];

  let candidateCampaigns: CandidateCampaignForDeadline[] = [];

  try {
    candidateCampaigns = await db.campaign.findMany({
      where: {
        status: { in: targetStatuses },
      },
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        onUnresolved: true,
        promptFingerprint: true,
        subjectTemplate: true,
        bodyTemplate: true,
        linkUrl: true,
        unsubscribeUrl: true,
      },
    });
  } catch (err: unknown) {
    const errClass = (err as Error)?.constructor?.name || (err as Error)?.name || "Error";
    logger.error(`[Deadlines] Failed to query candidate campaigns: ${errClass}`);
    return { processedCampaigns: 0, cancelledCampaigns: 0, resolvedDrafts: 0 };
  }

  let processedCampaigns = 0;
  let cancelledCampaigns = 0;
  let totalResolvedDrafts = 0;

  for (const campaign of candidateCampaigns) {
    const scheduledAtMs = new Date(campaign.scheduledAt).getTime();
    const deadlineMs = scheduledAtMs - ai.finalizeLeadMs;

    if (now < deadlineMs) {
      continue;
    }

    try {
      processedCampaigns++;

      // a. SAMPLING, SAMPLE_REVIEW, PAUSED
      if (["SAMPLING", "SAMPLE_REVIEW", "PAUSED"].includes(campaign.status)) {
        let moved = false;
        await db.$transaction(async (tx: any) => {
          const current = await tx.campaign.findUnique({
            where: { id: campaign.id },
            select: { status: true },
          });
          if (!current || !["SAMPLING", "SAMPLE_REVIEW", "PAUSED"].includes(current.status)) {
            return;
          }
          moved = await transition(tx, campaign.id, current.status, "CANCELLED");
          if (moved) {
            await tx.campaign.update({
              where: { id: campaign.id },
              data: {
                errorMessage:
                  "The scheduled time passed before this campaign was ready, so nothing was sent.",
              },
            });
          }
        });

        if (moved) {
          cancelledCampaigns++;
          logger.info?.(`[Deadlines] Cancelled campaign ${campaign.id} at deadline`);
        }

        await refresh(campaign.id, { db, clock: deps.clock, ai, logger });
        continue;
      }

      // b. GENERATING
      if (campaign.status === "GENERATING" && campaign.promptFingerprint) {
        const resolvedIncomplete = await resolveUnfinished(
          db,
          campaign,
          ["PENDING", "GENERATING"],
          "GENERATION_INCOMPLETE_AT_DEADLINE",
          DEADLINE_CHUNK_SIZE
        );

        const resolvedFlagged = await resolveUnfinished(
          db,
          campaign,
          ["FLAGGED"],
          "UNRESOLVED_AT_DEADLINE",
          DEADLINE_CHUNK_SIZE
        );

        totalResolvedDrafts += resolvedIncomplete + resolvedFlagged;

        logger.info?.(
          `[Deadlines] Campaign ${campaign.id} resolved ${resolvedIncomplete} incomplete and ${resolvedFlagged} flagged drafts`
        );

        await refresh(campaign.id, { db, clock: deps.clock, ai, logger });
        continue;
      }

      // c. EXCEPTION_REVIEW
      if (campaign.status === "EXCEPTION_REVIEW" && campaign.promptFingerprint) {
        const resolvedFlagged = await resolveUnfinished(
          db,
          campaign,
          ["FLAGGED"],
          "UNRESOLVED_AT_DEADLINE",
          DEADLINE_CHUNK_SIZE
        );

        totalResolvedDrafts += resolvedFlagged;

        logger.info?.(
          `[Deadlines] Campaign ${campaign.id} resolved ${resolvedFlagged} flagged drafts at deadline`
        );

        await refresh(campaign.id, { db, clock: deps.clock, ai, logger });
        continue;
      }
    } catch (err: unknown) {
      const errClass = (err as Error)?.constructor?.name || (err as Error)?.name || "Error";
      logger.error(`[Deadlines] Error processing campaign ${campaign.id}: ${errClass}`);
    }
  }

  return {
    processedCampaigns,
    cancelledCampaigns,
    resolvedDrafts: totalResolvedDrafts,
  };
}
