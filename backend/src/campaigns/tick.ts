/**
 * Background campaign tick (spec Phase 5a).
 *
 * Runs once at start, then every CAMPAIGN_TICK_MS using a setTimeout chain (not setInterval).
 * A running flag ensures runs never overlap. Timers are unref'd so they do not keep the process alive.
 *
 * Each run:
 * 1. `reconcileGeneration()` for active campaigns in SAMPLING or GENERATING.
 * 2. `refreshCampaign()` for every campaign in SAMPLING, GENERATING or EXCEPTION_REVIEW.
 *
 * Failure resilience:
 * - One campaign failing never stops the others.
 * - Logs ids, counts, and error classes only (no sensitive recipient/prompt data).
 *
 * Returns a stop function.
 */

import type { PrismaClient, CampaignStatus } from "../generated/prisma/client";
import { config } from "../config";
import {
  reconcileGeneration,
  reconcileSends,
  type ReconcileGenerationDeps,
  type ReconcileGenerationResult,
  type ReconcileSendsDeps,
  type ReconcileSendsResult,
} from "./reconcile";
import { refreshCampaign, type FlowDeps } from "./flow";

export interface CampaignTickOptions {
  intervalMs?: number;
}

export interface CampaignTickDeps {
  db?: PrismaClient;
  reconcile?: (campaignId?: string, deps?: ReconcileGenerationDeps) => Promise<ReconcileGenerationResult>;
  reconcileSends?: (campaignId?: string, deps?: ReconcileSendsDeps) => Promise<ReconcileSendsResult>;
  refresh?: (
    campaignId: string,
    deps?: FlowDeps
  ) => Promise<{ refreshed: boolean; from?: CampaignStatus; to?: CampaignStatus }>;
  logger?: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
}

/**
 * Execute a single iteration of the campaign tick:
 * 1. Reconcile generation jobs for SAMPLING/GENERATING campaigns.
 * 2. Refresh each campaign in SAMPLING, GENERATING, or EXCEPTION_REVIEW.
 *
 * Isolated and resilient: an error in one campaign does not abort the loop.
 */
export async function executeCampaignTickRun(deps: CampaignTickDeps = {}): Promise<void> {
  const db = deps.db ?? (await import("../db/pool")).prisma;
  const reconcile = deps.reconcile ?? reconcileGeneration;
  const refresh = deps.refresh ?? refreshCampaign;
  const logger = deps.logger ?? console;

  // 1. Reconcile generation jobs
  try {
    const outcome = await reconcile(undefined, { db });
    if (outcome.reconciledCount > 0) {
      logger.info(`[CampaignTick] Reconciled ${outcome.reconciledCount} generation drafts`);
    }
  } catch (err: unknown) {
    const errClass = (err as Error)?.constructor?.name || (err as Error)?.name || "Error";
    logger.error(`[CampaignTick] Reconcile error: ${errClass}`);
  }

  // 2. Query campaigns in SAMPLING, GENERATING, or EXCEPTION_REVIEW
  let activeCampaigns: { id: string; status: CampaignStatus }[] = [];
  try {
    activeCampaigns = await db.campaign.findMany({
      where: {
        status: { in: ["SAMPLING", "GENERATING", "EXCEPTION_REVIEW"] },
      },
      select: { id: true, status: true },
    });
  } catch (err: unknown) {
    const errClass = (err as Error)?.constructor?.name || (err as Error)?.name || "Error";
    logger.error(`[CampaignTick] Failed to load active campaigns: ${errClass}`);
    return;
  }

  for (const campaign of activeCampaigns) {
    try {
      const outcome = await refresh(campaign.id, { db });
      if (outcome.refreshed) {
        logger.info(
          `[CampaignTick] Campaign ${campaign.id} moved: ${outcome.from} -> ${outcome.to}`
        );
      }
    } catch (err: unknown) {
      const errClass = (err as Error)?.constructor?.name || (err as Error)?.name || "Error";
      logger.error(`[CampaignTick] Campaign ${campaign.id} refresh error: ${errClass}`);
    }
  }

  // 3. Reconcile send jobs for SCHEDULED and SENDING campaigns
  try {
    const reconcileSendsFn = deps.reconcileSends ?? reconcileSends;
    const outcome = await reconcileSendsFn(undefined, { db });
    if (outcome.reconciledCount > 0) {
      logger.info(`[CampaignTick] Reconciled ${outcome.reconciledCount} send jobs`);
    }
  } catch (err: unknown) {
    const errClass = (err as Error)?.constructor?.name || (err as Error)?.name || "Error";
    logger.error(`[CampaignTick] Reconcile sends error: ${errClass}`);
  }
}

/**
 * Start the recurring campaign tick background worker.
 * Returns an async stop function that clears the timer, sets stopped, and awaits the in-flight run if there is one.
 */
export function startCampaignTick(
  options: CampaignTickOptions = {},
  deps: CampaignTickDeps = {}
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? config.ai.campaignTickMs;

  let isRunning = false;
  let inFlightRun: Promise<void> | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const runTick = async () => {
    if (stopped || isRunning) return;
    isRunning = true;
    const currentRun = (async () => {
      try {
        await executeCampaignTickRun(deps);
      } finally {
        isRunning = false;
        inFlightRun = null;
        if (!stopped) {
          scheduleNext();
        }
      }
    })();
    inFlightRun = currentRun;
    await currentRun;
  };

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(runTick, intervalMs);
    if (typeof timer?.unref === "function") {
      timer.unref();
    }
  };

  // Run once immediately at start
  void runTick();

  return async () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (inFlightRun !== null) {
      await inFlightRun;
    }
  };
}
