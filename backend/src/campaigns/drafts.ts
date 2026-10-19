/**
 * Campaign draft resolution, bulk actions, and summary operations (Phase 5b).
 *
 * Service functions for human-in-the-loop exception review:
 * - `resolveDraft`: approve, use_plain, or edit a single draft with status preconditions.
 * - `bulkResolve`: bulk approve or fallback FLAGGED drafts matching current fingerprint.
 * - `listDrafts`: cursor-paged list of drafts for the current fingerprint.
 * - `getCampaignSummary`: campaign overview with recipient and per-status draft counts.
 */

import { Prisma, type PrismaClient, type CampaignStatus, type DraftStatus } from "../generated/prisma/client";
import type { AiConfig } from "../config/ai";
import { config } from "../config";
import { renderCampaignEmail } from "./values";
import { runGuardrails, type GuardrailFailure } from "../ai/guardrails";
import { refreshCampaign } from "./flow";

export const HARD_BLOCK_CODES = [
  "FORBIDDEN_CONTENT",
  "INJECTION_SUSPECTED",
  "RENDER_INVALID",
];

export class HardBlockedError extends Error {
  readonly code = "HARD_BLOCKED";
  readonly blockedCodes: string[];

  constructor(codes: string[]) {
    super(`Cannot approve draft with hard-blocked codes: ${codes.join(", ")}`);
    this.name = "HardBlockedError";
    this.blockedCodes = codes;
  }
}

export class DraftNotFoundError extends Error {
  readonly code = "DRAFT_NOT_FOUND";

  constructor(message = "Draft not found") {
    super(message);
    this.name = "DraftNotFoundError";
  }
}

export class CampaignNotFoundError extends Error {
  readonly code = "CAMPAIGN_NOT_FOUND";

  constructor(message = "Campaign not found") {
    super(message);
    this.name = "CampaignNotFoundError";
  }
}

export class CampaignNotUnderReviewError extends Error {
  readonly code = "CAMPAIGN_NOT_UNDER_REVIEW";

  constructor(message = "Draft's campaign is not in EXCEPTION_REVIEW") {
    super(message);
    this.name = "CampaignNotUnderReviewError";
  }
}

export class StaleDraftError extends Error {
  readonly code = "STALE_DRAFT";

  constructor(message = "Draft promptVersion does not match current campaign promptFingerprint") {
    super(message);
    this.name = "StaleDraftError";
  }
}

export function extractFlagCodes(flagReasons: unknown): string[] {
  if (!Array.isArray(flagReasons)) return [];
  const codes: string[] = [];
  for (const item of flagReasons) {
    if (typeof item === "string") {
      codes.push(item);
    } else if (
      item &&
      typeof item === "object" &&
      "code" in item &&
      typeof (item as any).code === "string"
    ) {
      codes.push((item as any).code);
    }
  }
  return codes;
}

export function getHardBlockedCodes(flagReasons: unknown): string[] {
  const codes = extractFlagCodes(flagReasons);
  const found = new Set<string>();
  for (const c of codes) {
    if (HARD_BLOCK_CODES.includes(c)) {
      found.add(c);
    }
  }
  return HARD_BLOCK_CODES.filter((c) => found.has(c));
}

export type ResolveDraftAction =
  | { type: "approve" }
  | { type: "use_plain" }
  | { type: "edit"; aiIntro: string };

export interface ResolveDraftResult {
  applied: boolean;
  status: DraftStatus;
  flagReasons?: unknown[];
}

export interface BulkResolveOptions {
  type: "approve" | "use_plain";
  codes?: string[];
}

export interface BulkResolveResult {
  changed: number;
  skippedHardBlocked: number;
}

export interface ListDraftsOptions {
  status?: DraftStatus;
  isSample?: boolean;
  cursor?: string;
  limit?: number;
}

export interface DraftListItem {
  id: string;
  status: DraftStatus;
  isSample: boolean;
  recipient: {
    email: string;
    firstName: string | null;
  };
  recipientEmail: string;
  recipientFirstName: string | null;
  aiIntro: string | null;
  subject: string;
  body: string;
  flagReasons: unknown;
  fallbackReason: string | null;
  resolvedBy: string | null;
}

export interface CampaignSummary {
  status: CampaignStatus;
  errorMessage: string | null;
  scheduledAt: Date;
  recipientCount: number;
  draftCounts: Record<DraftStatus, number>;
  counts: Record<DraftStatus, number>;
}

export const BULK_RESOLVE_CHUNK_SIZE = 50;

export interface DraftDeps {
  db?: PrismaClient;
  ai?: AiConfig;
  refreshCampaign?: (campaignId: string, deps?: any) => Promise<any>;
  chunkSize?: number;
  logger?: {
    error: (message: string) => void;
    info?: (message: string) => void;
  };
}

/**
 * Resolve a single draft in EXCEPTION_REVIEW.
 * Uses a status precondition on every update and returns whether it applied.
 * Calls refreshCampaign(campaignId) after any applied change.
 */
export async function resolveDraft(
  draftId: string,
  action: ResolveDraftAction,
  deps: DraftDeps = {}
): Promise<ResolveDraftResult> {
  const db = deps.db ?? (await import("../db/pool")).prisma;
  const ai = deps.ai ?? config.ai;

  let campaignId = "";
  let applied = false;
  let finalStatus: DraftStatus = "PENDING";
  let finalFlagReasons: unknown[] = [];

  await db.$transaction(async (tx) => {
    const draft = await tx.generatedDraft.findUnique({
      where: { id: draftId },
      include: {
        campaign: true,
        recipient: true,
      },
    });

    if (!draft) {
      throw new DraftNotFoundError(`Draft ${draftId} does not exist`);
    }

    if (draft.campaign.status !== "EXCEPTION_REVIEW") {
      throw new CampaignNotUnderReviewError(
        `Campaign ${draft.campaign.id} is in status ${draft.campaign.status}, expected EXCEPTION_REVIEW`
      );
    }

    if (!draft.campaign.promptFingerprint || draft.promptVersion !== draft.campaign.promptFingerprint) {
      throw new StaleDraftError(
        `Draft promptVersion ${draft.promptVersion} does not match campaign promptFingerprint ${draft.campaign.promptFingerprint}`
      );
    }

    campaignId = draft.campaignId;
    finalStatus = draft.status;
    finalFlagReasons = (draft.flagReasons as unknown[]) ?? [];

    if (action.type === "approve") {
      const blocked = getHardBlockedCodes(draft.flagReasons);
      if (blocked.length > 0) {
        throw new HardBlockedError(blocked);
      }

      const result = await tx.generatedDraft.updateMany({
        where: {
          id: draftId,
          status: "FLAGGED",
        },
        data: {
          status: "APPROVED",
          resolvedBy: "USER",
        },
      });

      if (result.count > 0) {
        applied = true;
        finalStatus = "APPROVED";
      }
    } else if (action.type === "use_plain") {
      const rendered = renderCampaignEmail({
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
        aiIntro: undefined,
      });

      const result = await tx.generatedDraft.updateMany({
        where: {
          id: draftId,
          status: { in: ["FLAGGED", "READY", "APPROVED"] },
        },
        data: {
          status: "FALLBACK",
          aiIntro: null,
          subject: rendered.subject,
          body: rendered.body,
          fallbackReason: "USER_PLAIN",
          resolvedBy: "USER",
          flagReasons: Prisma.DbNull,
        },
      });

      if (result.count > 0) {
        applied = true;
        finalStatus = "FALLBACK";
        finalFlagReasons = [];
      }
    } else if (action.type === "edit") {
      const trimmedIntro = action.aiIntro.trim();

      const rendered = renderCampaignEmail({
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
        aiIntro: trimmedIntro,
      });

      const failures = runGuardrails({
        intro: trimmedIntro,
        recipient: {
          first_name: draft.recipient.firstName,
          company: draft.recipient.company,
          role: draft.recipient.role,
          note: draft.recipient.note,
        },
        campaign: {
          linkUrl: draft.campaign.linkUrl,
          unsubscribeUrl: draft.campaign.unsubscribeUrl,
        },
        renderedSubject: rendered.subject,
        renderedBody: rendered.body,
        introMaxChars: ai.introMaxChars ?? 240,
      });

      const nextStatus: DraftStatus = failures.length === 0 ? "APPROVED" : "FLAGGED";
      const dbFlagReasons =
        failures.length === 0
          ? Prisma.DbNull
          : (failures as unknown as Prisma.InputJsonValue);

      const result = await tx.generatedDraft.updateMany({
        where: {
          id: draftId,
          status: { in: ["FLAGGED", "READY", "APPROVED"] },
        },
        data: {
          status: nextStatus,
          aiIntro: trimmedIntro,
          subject: rendered.subject,
          body: rendered.body,
          resolvedBy: "USER",
          flagReasons: dbFlagReasons,
        },
      });

      if (result.count > 0) {
        applied = true;
        finalStatus = nextStatus;
        finalFlagReasons = failures;
      }
    }
  });

  if (applied && campaignId) {
    const refreshFn = deps.refreshCampaign ?? refreshCampaign;
    try {
      await refreshFn(campaignId, { db });
    } catch (err: unknown) {
      const errClass = (err as Error)?.constructor?.name || (err as Error)?.name || "Error";
      const logger = deps.logger ?? console;
      logger.error(`[Drafts] refreshCampaign failed: ${errClass}`);
    }
  }

  return {
    applied,
    status: finalStatus,
    flagReasons: finalFlagReasons,
  };
}

/**
 * Bulk resolve FLAGGED drafts for a campaign in EXCEPTION_REVIEW.
 * Applies approve or use_plain to drafts with current fingerprint,
 * optionally filtered by guardrail failure codes.
 * Returns count changed, then calls refreshCampaign once.
 */
export async function bulkResolve(
  campaignId: string,
  options: BulkResolveOptions,
  deps: DraftDeps = {}
): Promise<BulkResolveResult> {
  const db = deps.db ?? (await import("../db/pool")).prisma;

  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
  });

  if (!campaign) {
    throw new CampaignNotFoundError(`Campaign ${campaignId} does not exist`);
  }

  if (campaign.status !== "EXCEPTION_REVIEW") {
    throw new CampaignNotUnderReviewError(
      `Campaign ${campaignId} is in status ${campaign.status}, expected EXCEPTION_REVIEW`
    );
  }

  if (!campaign.promptFingerprint) {
    return { changed: 0, skippedHardBlocked: 0 };
  }

  const drafts = await db.generatedDraft.findMany({
    where: {
      campaignId,
      promptVersion: campaign.promptFingerprint,
      status: "FLAGGED",
    },
    include: {
      recipient: true,
    },
    orderBy: { id: "asc" },
  });

  let targetDrafts = drafts;
  if (options.codes && options.codes.length > 0) {
    const codeSet = new Set(options.codes);
    targetDrafts = drafts.filter((d) => {
      const codes = extractFlagCodes(d.flagReasons);
      return codes.some((code) => codeSet.has(code));
    });
  }

  let skippedHardBlocked = 0;
  let draftsToProcess = targetDrafts;

  if (options.type === "approve") {
    const allowed: typeof targetDrafts = [];
    for (const draft of targetDrafts) {
      if (getHardBlockedCodes(draft.flagReasons).length > 0) {
        skippedHardBlocked++;
      } else {
        allowed.push(draft);
      }
    }
    draftsToProcess = allowed;
  }

  const chunkSize = deps.chunkSize ?? BULK_RESOLVE_CHUNK_SIZE;
  let changed = 0;

  for (let i = 0; i < draftsToProcess.length; i += chunkSize) {
    const chunk = draftsToProcess.slice(i, i + chunkSize);
    const chunkCount = await db.$transaction(async (tx) => {
      let subCount = 0;
      if (options.type === "approve") {
        const targetIds = chunk.map((d) => d.id);
        const res = await tx.generatedDraft.updateMany({
          where: {
            id: { in: targetIds },
            status: "FLAGGED",
          },
          data: {
            status: "APPROVED",
            resolvedBy: "USER",
          },
        });
        subCount = res.count;
      } else if (options.type === "use_plain") {
        for (const draft of chunk) {
          const rendered = renderCampaignEmail({
            subjectTemplate: campaign.subjectTemplate,
            bodyTemplate: campaign.bodyTemplate,
            recipient: {
              firstName: draft.recipient.firstName,
              company: draft.recipient.company,
              role: draft.recipient.role,
              note: draft.recipient.note,
              extra: (draft.recipient.extra ?? undefined) as Record<string, unknown> | undefined,
            },
            campaign: {
              linkUrl: campaign.linkUrl,
              unsubscribeUrl: campaign.unsubscribeUrl,
            },
            aiIntro: undefined,
          });

          const res = await tx.generatedDraft.updateMany({
            where: {
              id: draft.id,
              status: "FLAGGED",
            },
            data: {
              status: "FALLBACK",
              aiIntro: null,
              subject: rendered.subject,
              body: rendered.body,
              fallbackReason: "USER_PLAIN",
              resolvedBy: "USER",
              flagReasons: Prisma.DbNull,
            },
          });
          subCount += res.count;
        }
      }
      return subCount;
    });

    changed += chunkCount;
  }

  const refreshFn = deps.refreshCampaign ?? refreshCampaign;
  try {
    await refreshFn(campaignId, { db });
  } catch (err: unknown) {
    const errClass = (err as Error)?.constructor?.name || (err as Error)?.name || "Error";
    const logger = deps.logger ?? console;
    logger.error(`[Drafts] refreshCampaign failed: ${errClass}`);
  }

  return { changed, skippedHardBlocked };
}

/**
 * List drafts for a campaign with cursor pagination, filtered by current prompt fingerprint.
 */
export async function listDrafts(
  campaignId: string,
  options: ListDraftsOptions = {},
  deps: DraftDeps = {}
): Promise<DraftListItem[]> {
  const db = deps.db ?? (await import("../db/pool")).prisma;
  const limit = Math.min(Math.max(1, options.limit ?? 50), 100);

  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: { promptFingerprint: true },
  });

  if (!campaign) {
    throw new CampaignNotFoundError(`Campaign ${campaignId} does not exist`);
  }

  if (!campaign.promptFingerprint) {
    return [];
  }

  const drafts = await db.generatedDraft.findMany({
    where: {
      campaignId,
      promptVersion: campaign.promptFingerprint,
      ...(options.status ? { status: options.status } : {}),
      ...(options.isSample !== undefined ? { isSample: options.isSample } : {}),
    },
    take: limit,
    skip: options.cursor ? 1 : 0,
    cursor: options.cursor ? { id: options.cursor } : undefined,
    orderBy: { id: "asc" },
    select: {
      id: true,
      status: true,
      isSample: true,
      aiIntro: true,
      subject: true,
      body: true,
      flagReasons: true,
      fallbackReason: true,
      resolvedBy: true,
      recipient: {
        select: {
          email: true,
          firstName: true,
        },
      },
    },
  });

  return drafts.map((d) => ({
    id: d.id,
    status: d.status,
    isSample: d.isSample,
    recipient: {
      email: d.recipient.email,
      firstName: d.recipient.firstName,
    },
    recipientEmail: d.recipient.email,
    recipientFirstName: d.recipient.firstName,
    aiIntro: d.aiIntro,
    subject: d.subject,
    body: d.body,
    flagReasons: d.flagReasons,
    fallbackReason: d.fallbackReason,
    resolvedBy: d.resolvedBy,
  }));
}

/**
 * Retrieve campaign summary including status, errorMessage, scheduledAt,
 * recipientCount, and draft counts per status for the current prompt fingerprint.
 */
export async function getCampaignSummary(
  campaignId: string,
  deps: DraftDeps = {}
): Promise<CampaignSummary> {
  const db = deps.db ?? (await import("../db/pool")).prisma;

  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      status: true,
      errorMessage: true,
      scheduledAt: true,
      promptFingerprint: true,
    },
  });

  if (!campaign) {
    throw new CampaignNotFoundError(`Campaign ${campaignId} does not exist`);
  }

  const recipientCount = await db.recipient.count({
    where: { campaignId },
  });

  const counts: Record<DraftStatus, number> = {
    PENDING: 0,
    GENERATING: 0,
    READY: 0,
    FLAGGED: 0,
    FALLBACK: 0,
    APPROVED: 0,
    HELD: 0,
    QUEUED: 0,
  };

  if (campaign.promptFingerprint) {
    if (typeof (db.generatedDraft as any).groupBy === "function") {
      const grouped = await (db.generatedDraft as any).groupBy({
        by: ["status"],
        where: {
          campaignId,
          promptVersion: campaign.promptFingerprint,
        },
        _count: {
          _all: true,
        },
      });

      for (const row of grouped) {
        if (row.status in counts) {
          counts[row.status as DraftStatus] = row._count._all;
        }
      }
    } else {
      const drafts = await db.generatedDraft.findMany({
        where: {
          campaignId,
          promptVersion: campaign.promptFingerprint,
        },
        select: { status: true },
      });

      for (const d of drafts) {
        if (d.status in counts) {
          counts[d.status as DraftStatus]++;
        }
      }
    }
  }

  return {
    status: campaign.status,
    errorMessage: campaign.errorMessage,
    scheduledAt: campaign.scheduledAt,
    recipientCount,
    draftCounts: counts,
    counts,
  };
}
