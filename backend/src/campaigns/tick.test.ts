import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCampaignTickRun, startCampaignTick, type CampaignTickDeps } from "./tick";

describe("tick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("executeCampaignTickRun", () => {
    it("runs reconcile and refreshes each campaign in SAMPLING, GENERATING or EXCEPTION_REVIEW", async () => {
      const db = {
        campaign: {
          findMany: vi.fn().mockResolvedValue([
            { id: "c1", status: "SAMPLING" },
            { id: "c2", status: "GENERATING" },
            { id: "c3", status: "EXCEPTION_REVIEW" },
          ]),
        },
      } as any;

      const reconcile = vi.fn().mockResolvedValue({ reconciledCount: 2, draftIds: ["d1", "d2"] });
      const refresh = vi.fn().mockResolvedValue({ refreshed: true, from: "SAMPLING", to: "SAMPLE_REVIEW" });
      const logger = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await executeCampaignTickRun({ db, reconcile, refresh, logger });

      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(db.campaign.findMany).toHaveBeenCalledWith({
        where: { status: { in: ["SAMPLING", "GENERATING", "EXCEPTION_REVIEW"] } },
        select: { id: true, status: true },
      });
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(refresh).toHaveBeenCalledWith("c1", { db });
      expect(refresh).toHaveBeenCalledWith("c2", { db });
      expect(refresh).toHaveBeenCalledWith("c3", { db });

      // Verifies info logs contain counts and transition names
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("2 generation drafts"));
    });

    it("continues running other campaigns when one campaign refresh fails", async () => {
      const db = {
        campaign: {
          findMany: vi.fn().mockResolvedValue([
            { id: "c1", status: "SAMPLING" },
            { id: "c2", status: "GENERATING" },
          ]),
        },
      } as any;

      const reconcile = vi.fn().mockResolvedValue({ reconciledCount: 0, draftIds: [] });
      const refresh = vi.fn()
        .mockRejectedValueOnce(new TypeError("Network error"))
        .mockResolvedValueOnce({ refreshed: true, from: "GENERATING", to: "SCHEDULED" });

      const logger = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await executeCampaignTickRun({ db, reconcile, refresh, logger });

      expect(refresh).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/\[CampaignTick\] Campaign c1 refresh error: TypeError/)
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringMatching(/\[CampaignTick\] Campaign c2 moved: GENERATING -> SCHEDULED/)
      );
    });

    it("logs error class only when reconcile throws, and still refreshes campaigns", async () => {
      class DatabaseTimeoutError extends Error {
        constructor() {
          super("Database connection timed out");
          this.name = "DatabaseTimeoutError";
        }
      }

      const db = {
        campaign: {
          findMany: vi.fn().mockResolvedValue([{ id: "c1", status: "SAMPLING" }]),
        },
      } as any;

      const reconcile = vi.fn().mockRejectedValue(new DatabaseTimeoutError());
      const refresh = vi.fn().mockResolvedValue({ refreshed: false });
      const logger = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await executeCampaignTickRun({ db, reconcile, refresh, logger });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/\[CampaignTick\] Reconcile error: DatabaseTimeoutError/)
      );
      expect(refresh).toHaveBeenCalledWith("c1", { db });
    });
  });

  describe("startCampaignTick", () => {
    it("runs once immediately and then every intervalMs without overlapping", async () => {
      let activeRuns = 0;
      let maxOverlap = 0;
      let runCount = 0;

      const deps: CampaignTickDeps = {
        db: {
          campaign: {
            findMany: vi.fn().mockResolvedValue([]),
          },
        } as any,
        reconcile: vi.fn().mockImplementation(async () => {
          activeRuns++;
          maxOverlap = Math.max(maxOverlap, activeRuns);
          runCount++;
          // Simulate async work
          await new Promise((resolve) => setTimeout(resolve, 50));
          activeRuns--;
          return { reconciledCount: 0, draftIds: [] };
        }),
        refresh: vi.fn().mockResolvedValue({ refreshed: false }),
        logger: { info: vi.fn(), error: vi.fn() },
      };

      const stop = startCampaignTick({ intervalMs: 1000 }, deps);

      // Runs once at start
      expect(runCount).toBe(1);

      // Advance through simulated async work
      await vi.advanceTimersByTimeAsync(60);
      expect(maxOverlap).toBe(1);

      // Advance by intervalMs (1000)
      await vi.advanceTimersByTimeAsync(1000);
      expect(runCount).toBe(2);

      await vi.advanceTimersByTimeAsync(60);
      expect(maxOverlap).toBe(1);

      // Advance again
      await vi.advanceTimersByTimeAsync(1000);
      expect(runCount).toBe(3);

      await vi.advanceTimersByTimeAsync(60);
      expect(maxOverlap).toBe(1);

      await stop();

      // Advancing further after stop does not trigger more runs
      await vi.advanceTimersByTimeAsync(5000);
      expect(runCount).toBe(3);
    });

    it("stop function clears the timer and prevents scheduled execution", async () => {
      const reconcile = vi.fn().mockResolvedValue({ reconciledCount: 0, draftIds: [] });
      const db = {
        campaign: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      } as any;

      const stop = startCampaignTick({ intervalMs: 1000 }, { db, reconcile });

      // Run once at start
      expect(reconcile).toHaveBeenCalledTimes(1);

      await stop();

      // Advance timers by multiple intervals
      await vi.advanceTimersByTimeAsync(5000);

      // Should still be only 1 call
      expect(reconcile).toHaveBeenCalledTimes(1);
    });

    it("stop() during a slow run resolves only after that run ends and no further run is scheduled", async () => {
      let runFinished = false;
      let runCount = 0;

      let resolveSlowRun!: () => void;
      const slowWork = new Promise<void>((resolve) => {
        resolveSlowRun = resolve;
      });

      const deps: CampaignTickDeps = {
        db: {
          campaign: { findMany: vi.fn().mockResolvedValue([]) },
        } as any,
        reconcile: vi.fn().mockImplementation(async () => {
          runCount++;
          await slowWork;
          runFinished = true;
          return { reconciledCount: 0, draftIds: [] };
        }),
        refresh: vi.fn().mockResolvedValue({ refreshed: false }),
        logger: { info: vi.fn(), error: vi.fn() },
      };

      const stop = startCampaignTick({ intervalMs: 1000 }, deps);

      // Initial run started but is waiting on slowWork
      expect(runCount).toBe(1);
      expect(runFinished).toBe(false);

      // Call stop() while the slow run is in flight
      let stopResolved = false;
      const stopPromise = stop().then(() => {
        stopResolved = true;
      });

      // Allow microtasks to execute: stopPromise must NOT have resolved yet
      await Promise.resolve();
      expect(stopResolved).toBe(false);
      expect(runFinished).toBe(false);

      // Complete the slow in-flight run
      resolveSlowRun();
      await stopPromise;

      expect(stopResolved).toBe(true);
      expect(runFinished).toBe(true);

      // Advance timers by multiple intervals: no further run should be scheduled
      await vi.advanceTimersByTimeAsync(5000);
      expect(runCount).toBe(1);
    });
  });
});
