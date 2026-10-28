import { describe, it, expect } from "vitest";
import { CampaignStatus } from "@/types/campaigns";
import {
  getAvailableActionsForStatus,
  getReviewDeadline,
  getMsUntilReviewDeadline,
  formatCountdown,
  getUnresolvedPolicyDescription,
  getStartConfirmMessage,
  CANCEL_CONFIRM_MESSAGE,
  FINALIZE_LEAD_MINUTES,
} from "./campaignLifecycle";

describe("campaignLifecycle", () => {
  describe("getAvailableActionsForStatus (for every status)", () => {
    const statuses: CampaignStatus[] = [
      "DRAFT",
      "SAMPLING",
      "SAMPLE_REVIEW",
      "GENERATING",
      "EXCEPTION_REVIEW",
      "SCHEDULED",
      "SENDING",
      "PAUSED",
      "COMPLETED",
      "CANCELLED",
    ];

    it("evaluates actions correctly for DRAFT", () => {
      const actions = getAvailableActionsForStatus("DRAFT", false);
      expect(actions.canStart).toBe(true);
      expect(actions.canPause).toBe(false);
      expect(actions.canResume).toBe(false);
      expect(actions.canCancel).toBe(true);
      expect(actions.isReadOnly).toBe(false);
      expect(actions.shouldPoll).toBe(true);
    });

    it("evaluates actions correctly for SAMPLING and GENERATING", () => {
      for (const status of ["SAMPLING", "GENERATING"] as CampaignStatus[]) {
        const actions = getAvailableActionsForStatus(status, true);
        expect(actions.canStart).toBe(false);
        expect(actions.canPause).toBe(true);
        expect(actions.canResume).toBe(false);
        expect(actions.canCancel).toBe(true);
        expect(actions.shouldPoll).toBe(true);
      }
    });

    it("evaluates actions correctly for SAMPLE_REVIEW", () => {
      const actions = getAvailableActionsForStatus("SAMPLE_REVIEW", true);
      expect(actions.canReviewSamples).toBe(true);
      expect(actions.canReviewExceptions).toBe(false);
      expect(actions.canPause).toBe(true);
      expect(actions.canCancel).toBe(true);
      expect(actions.shouldPoll).toBe(true);
    });

    it("evaluates actions correctly for EXCEPTION_REVIEW", () => {
      const actions = getAvailableActionsForStatus("EXCEPTION_REVIEW", true);
      expect(actions.canReviewSamples).toBe(false);
      expect(actions.canReviewExceptions).toBe(true);
      expect(actions.canPause).toBe(true);
      expect(actions.canCancel).toBe(true);
      expect(actions.shouldPoll).toBe(true);
    });

    it("evaluates actions correctly for PAUSED", () => {
      const actions = getAvailableActionsForStatus("PAUSED", true);
      expect(actions.canResume).toBe(true);
      expect(actions.canPause).toBe(false);
      expect(actions.canCancel).toBe(true);
      expect(actions.shouldPoll).toBe(true);
    });

    it("evaluates actions correctly for SCHEDULED and SENDING", () => {
      for (const status of ["SCHEDULED", "SENDING"] as CampaignStatus[]) {
        const actions = getAvailableActionsForStatus(status, false);
        expect(actions.canStart).toBe(false);
        expect(actions.canPause).toBe(false);
        expect(actions.canResume).toBe(false);
        expect(actions.canCancel).toBe(true);
        expect(actions.shouldPoll).toBe(true);
      }
    });

    it("evaluates actions correctly for terminal states COMPLETED and CANCELLED", () => {
      for (const status of ["COMPLETED", "CANCELLED"] as CampaignStatus[]) {
        const actions = getAvailableActionsForStatus(status, false);
        expect(actions.canStart).toBe(false);
        expect(actions.canPause).toBe(false);
        expect(actions.canResume).toBe(false);
        expect(actions.canCancel).toBe(false);
        expect(actions.isReadOnly).toBe(true);
        expect(actions.shouldPoll).toBe(false);
      }
    });

    it("covers every status in the enum", () => {
      for (const status of statuses) {
        const actions = getAvailableActionsForStatus(status, true);
        expect(actions).toBeDefined();
        expect(typeof actions.shouldPoll).toBe("boolean");
      }
    });
  });

  describe("deadline & countdown formatting", () => {
    it("computes review deadline 2 minutes before scheduledAt", () => {
      const scheduledAt = "2026-11-01T12:00:00.000Z";
      const deadline = getReviewDeadline(scheduledAt);
      expect(deadline.toISOString()).toBe("2026-11-01T11:58:00.000Z");
    });

    it("computes ms until review deadline relative to injected nowMs", () => {
      const scheduledAt = "2026-11-01T12:00:00.000Z";
      const deadlineMs = new Date("2026-11-01T11:58:00.000Z").getTime();
      const nowMs = deadlineMs - 30_000; // 30s before deadline
      expect(getMsUntilReviewDeadline(scheduledAt, nowMs)).toBe(30_000);
    });

    it("formats countdown for past deadline", () => {
      expect(formatCountdown(0)).toBe("Deadline has passed");
      expect(formatCountdown(-5000)).toBe("Deadline has passed");
    });

    it("formats countdown for minutes and seconds (< 1 hour)", () => {
      expect(formatCountdown(45 * 1000)).toBe("0m 45s");
      expect(formatCountdown(125 * 1000)).toBe("2m 5s");
    });

    it("formats countdown for hours, minutes and seconds (< 1 day)", () => {
      const ms = (2 * 3600 + 15 * 60 + 40) * 1000;
      expect(formatCountdown(ms)).toBe("2h 15m 40s");
    });

    it("formats countdown for days, hours and minutes (>= 1 day)", () => {
      const ms = (3 * 86400 + 4 * 3600 + 30 * 60 + 10) * 1000;
      expect(formatCountdown(ms)).toBe("3d 4h 30m");
    });
  });

  describe("confirm messages & unresolved policy", () => {
    it("returns start confirm message for AI campaigns", () => {
      const msg = getStartConfirmMessage({
        aiEnabled: true,
        recipientCount: 50,
        scheduledAtFormatted: "Nov 1, 10:00 AM",
      });
      expect(msg).toContain("begin sample generation");
    });

    it("returns start confirm message for plain campaigns with singular/plural count", () => {
      const singular = getStartConfirmMessage({
        aiEnabled: false,
        recipientCount: 1,
        scheduledAtFormatted: "Nov 1, 10:00 AM",
      });
      expect(singular).toContain("schedule 1 email to be sent");

      const plural = getStartConfirmMessage({
        aiEnabled: false,
        recipientCount: 10,
        scheduledAtFormatted: "Nov 1, 10:00 AM",
      });
      expect(plural).toContain("schedule 10 emails to be sent");
    });

    it("provides accurate cancel confirm message", () => {
      expect(CANCEL_CONFIRM_MESSAGE).toContain(
        "Any unsent emails will not be sent, and cancelling cannot be undone."
      );
    });

    it("describes unresolved policy for FALLBACK_TO_PLAIN and HOLD", () => {
      expect(getUnresolvedPolicyDescription("FALLBACK_TO_PLAIN")).toContain(
        "fall back to the plain email template"
      );
      expect(getUnresolvedPolicyDescription("HOLD")).toContain(
        "held and will not be sent"
      );
    });
  });
});
