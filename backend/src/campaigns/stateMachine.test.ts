import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_CAMPAIGN_TRANSITIONS,
  CAMPAIGN_STATUSES,
  IllegalTransitionError,
  isAllowedTransition,
  transition,
  type TransitionDb,
} from "./stateMachine";
import type { CampaignStatus } from "../generated/prisma/client";

describe("stateMachine", () => {
  describe("ALLOWED_CAMPAIGN_TRANSITIONS table specification", () => {
    it("has exactly 10 statuses defined", () => {
      expect(CAMPAIGN_STATUSES).toHaveLength(10);
      expect(Object.keys(ALLOWED_CAMPAIGN_TRANSITIONS)).toHaveLength(10);
    });

    it("has COMPLETED and CANCELLED as terminal statuses (no outgoing transitions)", () => {
      expect(ALLOWED_CAMPAIGN_TRANSITIONS.COMPLETED.size).toBe(0);
      expect(ALLOWED_CAMPAIGN_TRANSITIONS.CANCELLED.size).toBe(0);
    });

    it("has CANCELLED reachable from every non-terminal status", () => {
      const nonTerminalStatuses = CAMPAIGN_STATUSES.filter(
        (s) => s !== "COMPLETED" && s !== "CANCELLED"
      );
      for (const status of nonTerminalStatuses) {
        expect(
          ALLOWED_CAMPAIGN_TRANSITIONS[status].has("CANCELLED"),
          `Expected ${status} -> CANCELLED to be allowed`
        ).toBe(true);
      }
    });

    it("allows PAUSED to be reachable ONLY from SAMPLING, SAMPLE_REVIEW, GENERATING, EXCEPTION_REVIEW", () => {
      const allowedSourcesForPaused = new Set<CampaignStatus>([
        "SAMPLING",
        "SAMPLE_REVIEW",
        "GENERATING",
        "EXCEPTION_REVIEW",
      ]);

      for (const status of CAMPAIGN_STATUSES) {
        const canReachPaused = ALLOWED_CAMPAIGN_TRANSITIONS[status].has("PAUSED");
        if (allowedSourcesForPaused.has(status)) {
          expect(canReachPaused, `Expected ${status} -> PAUSED to be allowed`).toBe(true);
        } else {
          expect(canReachPaused, `Expected ${status} -> PAUSED to be illegal`).toBe(false);
        }
      }
    });

    it("allows PAUSED to transition ONLY to SAMPLING, GENERATING, CANCELLED", () => {
      expect(Array.from(ALLOWED_CAMPAIGN_TRANSITIONS.PAUSED).sort()).toEqual(
        ["CANCELLED", "GENERATING", "SAMPLING"].sort()
      );
    });

    it("has exactly the expected 24 allowed transitions", () => {
      let count = 0;
      for (const status of CAMPAIGN_STATUSES) {
        count += ALLOWED_CAMPAIGN_TRANSITIONS[status].size;
      }
      expect(count).toBe(24);
    });
  });

  describe("transition() for every allowed pair", () => {
    const allowedPairs: [CampaignStatus, CampaignStatus][] = [];
    for (const from of CAMPAIGN_STATUSES) {
      for (const to of CAMPAIGN_STATUSES) {
        if (isAllowedTransition(from, to)) {
          allowedPairs.push([from, to]);
        }
      }
    }

    it(`covers all ${allowedPairs.length} allowed pairs`, () => {
      expect(allowedPairs).toHaveLength(24);
    });

    it.each(allowedPairs)(
      "successfully moves status for allowed pair %s -> %s",
      async (from, to) => {
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const db: TransitionDb = {
          campaign: { updateMany },
        };

        const moved = await transition(db, "camp_1", from, to);

        expect(moved).toBe(true);
        expect(updateMany).toHaveBeenCalledWith({
          where: { id: "camp_1", status: from },
          data: { status: to },
        });
      }
    );

    it.each(allowedPairs)(
      "returns false if precondition fails for allowed pair %s -> %s",
      async (from, to) => {
        const updateMany = vi.fn().mockResolvedValue({ count: 0 });
        const db: TransitionDb = {
          campaign: { updateMany },
        };

        const moved = await transition(db, "camp_1", from, to);

        expect(moved).toBe(false);
        expect(updateMany).toHaveBeenCalledWith({
          where: { id: "camp_1", status: from },
          data: { status: to },
        });
      }
    );
  });

  describe("transition() for every illegal pair", () => {
    const illegalPairs: [CampaignStatus, CampaignStatus][] = [];
    for (const from of CAMPAIGN_STATUSES) {
      for (const to of CAMPAIGN_STATUSES) {
        if (!isAllowedTransition(from, to)) {
          illegalPairs.push([from, to]);
        }
      }
    }

    it(`covers all ${illegalPairs.length} illegal pairs`, () => {
      expect(illegalPairs).toHaveLength(76);
    });

    it.each(illegalPairs)(
      "throws IllegalTransitionError without calling db for illegal pair %s -> %s",
      async (from, to) => {
        const updateMany = vi.fn();
        const db: TransitionDb = {
          campaign: { updateMany },
        };

        await expect(transition(db, "camp_1", from, to)).rejects.toThrow(
          IllegalTransitionError
        );

        try {
          await transition(db, "camp_1", from, to);
        } catch (err) {
          const error = err as IllegalTransitionError;
          expect(error.from).toBe(from);
          expect(error.to).toBe(to);
          expect(error.code).toBe("ILLEGAL_TRANSITION");
          expect(error.message).toContain(`Illegal campaign transition from ${from} to ${to}`);
        }

        expect(updateMany).not.toHaveBeenCalled();
      }
    );
  });
});
