import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCampaignTickRun, startCampaignTick, type CampaignTickDeps } from "./tick";

function createFakeDb(initialState: {
  campaigns?: any[];
  recipients?: any[];
  drafts?: any[];
  emailJobs?: any[];
}) {
  const campaigns = new Map<string, any>(
    (initialState.campaigns ?? []).map((c) => [c.id, { ...c }])
  );
  const recipients = new Map<string, any>(
    (initialState.recipients ?? []).map((r) => [r.id, { ...r }])
  );
  const drafts = new Map<string, any>(
    (initialState.drafts ?? []).map((d) => [d.id, { ...d }])
  );
  const emailJobs = new Map<string, any>(
    (initialState.emailJobs ?? []).map((j) => [j.id, { ...j }])
  );

  const client = {
    campaign: {
      findMany: vi.fn(async ({ where }: { where?: any } = {}) => {
        let list = Array.from(campaigns.values());
        if (where?.status?.in) {
          list = list.filter((c) => where.status.in.includes(c.status));
        } else if (where?.status && typeof where.status === "string") {
          list = list.filter((c) => c.status === where.status);
        }
        if (where?.drafts?.some?.emailJob?.status?.in) {
          const statuses = where.drafts.some.emailJob.status.in;
          list = list.filter((c) => {
            const campDrafts = Array.from(drafts.values()).filter((d) => d.campaignId === c.id);
            return campDrafts.some((d) => {
              const job = emailJobs.get(d.emailJobId);
              return job && statuses.includes(job.status);
            });
          });
        }
        return list.map((c) => ({ ...c }));
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const c = campaigns.get(where.id);
        return c ? { ...c } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        const c = campaigns.get(where.id);
        if (!c) throw new Error("Not found");
        Object.assign(c, data);
        return { ...c };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: any }; data: any }) => {
        const c = campaigns.get(where.id);
        if (c && c.status === where.status) {
          Object.assign(c, data);
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
    recipient: {
      findMany: vi.fn(async ({ where }: { where?: { campaignId: string } }) => {
        const list = Array.from(recipients.values());
        if (where?.campaignId) {
          return list.filter((r) => r.campaignId === where.campaignId).map((r) => ({ ...r }));
        }
        return list.map((r) => ({ ...r }));
      }),
      count: vi.fn(async ({ where }: { where: { campaignId: string } }) => {
        return Array.from(recipients.values()).filter((r) => r.campaignId === where.campaignId).length;
      }),
    },
    generatedDraft: {
      findMany: vi.fn(async ({ where, include }: { where?: any; include?: any }) => {
        let list = Array.from(drafts.values());
        if (where?.campaignId) {
          list = list.filter((d) => d.campaignId === where.campaignId);
        }
        if (where?.promptVersion) {
          list = list.filter((d) => d.promptVersion === where.promptVersion);
        }
        if (where?.status) {
          if (typeof where.status === "string") {
            list = list.filter((d) => d.status === where.status);
          } else if (where.status.in) {
            list = list.filter((d) => where.status.in.includes(d.status));
          }
        }
        if (where?.emailJobId === null) {
          list = list.filter((d) => !d.emailJobId);
        }
        return list.map((d) => {
          const res = { ...d };
          if (include?.recipient) {
            res.recipient = recipients.get(d.recipientId) ?? {
              id: d.recipientId,
              email: `${d.recipientId}@example.com`,
            };
          }
          return res;
        });
      }),
      count: vi.fn(async ({ where }: { where: any }) => {
        let list = Array.from(drafts.values());
        if (where.campaignId) {
          list = list.filter((d) => d.campaignId === where.campaignId);
        }
        if (where.promptVersion) {
          list = list.filter((d) => d.promptVersion === where.promptVersion);
        }
        if (where.emailJobId === null || (where as any).emailJob === null) {
          list = list.filter((d) => !d.emailJobId);
        }
        if (where.status) {
          if (typeof where.status === "string") {
            list = list.filter((d) => d.status === where.status);
          } else if (where.status.in) {
            list = list.filter((d) => where.status.in.includes(d.status));
          }
        }
        return list.length;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string; status?: any; emailJob?: any }; data: any }) => {
        const existing = drafts.get(where.id);
        if (!existing) throw new Error(`Draft ${where.id} not found`);
        if (where.status !== undefined && existing.status !== where.status) {
          throw new Error("Precondition failed");
        }
        let emailJob = existing.emailJob;
        if (data.emailJob?.create) {
          const id = `job-${where.id}`;
          emailJob = { id, ...data.emailJob.create };
          emailJobs.set(id, emailJob);
        }
        const updated = {
          ...existing,
          ...data,
          emailJobId: emailJob ? emailJob.id : existing.emailJobId,
          emailJob,
        };
        drafts.set(where.id, updated);
        return updated;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: any; data: any }) => {
        let count = 0;
        const targetIds = where.id?.in ?? (where.id ? [where.id] : Array.from(drafts.keys()));
        for (const id of targetIds) {
          const d = drafts.get(id);
          if (!d) continue;
          if (where.campaignId && d.campaignId !== where.campaignId) continue;
          if (where.promptVersion && d.promptVersion !== where.promptVersion) continue;
          if (where.emailJobId === null && d.emailJobId !== null) continue;
          if (where.status) {
            if (typeof where.status === "string" && d.status !== where.status) continue;
            if (where.status.in && !where.status.in.includes(d.status)) continue;
          }
          Object.assign(d, data);
          count++;
        }
        return { count };
      }),
    },
    emailJob: {
      findMany: vi.fn(async ({ where, take }: { where?: any; take?: number } = {}) => {
        let list = Array.from(emailJobs.values());
        if (where?.id?.in) {
          list = list.filter((j) => where.id.in.includes(j.id));
        } else if (where?.id) {
          list = list.filter((j) => j.id === where.id);
        }
        if (where?.status?.in) {
          list = list.filter((j) => where.status.in.includes(j.status));
        } else if (where?.status) {
          list = list.filter((j) => j.status === where.status);
        }
        if (where?.generatedDraft?.campaignId) {
          const cId = where.generatedDraft.campaignId;
          const targetIds = cId.in ? cId.in : [cId];
          list = list.filter((j) => {
            const draft = Array.from(drafts.values()).find((d) => d.emailJobId === j.id);
            return draft && targetIds.includes(draft.campaignId);
          });
        }
        if (take !== undefined) {
          list = list.slice(0, take);
        }
        return list.map((j) => {
          const draft = Array.from(drafts.values()).find((d) => d.emailJobId === j.id);
          return {
            ...j,
            generatedDraft: draft ? { id: draft.id } : null,
          };
        });
      }),
      deleteMany: vi.fn(async ({ where }: { where: any }) => {
        let count = 0;
        const idsToDelete = where?.id?.in ? where.id.in : where?.id ? [where.id] : [];
        for (const id of idsToDelete) {
          const job = emailJobs.get(id);
          if (!job) continue;
          if (where?.status?.in && !where.status.in.includes(job.status)) continue;
          if (where?.status && typeof where.status === "string" && job.status !== where.status) continue;
          if (emailJobs.delete(id)) {
            count++;
            for (const d of drafts.values()) {
              if (d.emailJobId === id) {
                d.emailJobId = null;
                d.emailJob = null;
              }
            }
          }
        }
        return { count };
      }),
      count: vi.fn(async () => emailJobs.size),
    },
    $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(client)),
    _state: { campaigns, recipients, drafts, emailJobs },
  };

  return client as any;
}

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
      const enforceDeadlines = vi.fn().mockResolvedValue({ processedCampaigns: 0, cancelledCampaigns: 0, resolvedDrafts: 0 });
      const reconcileSends = vi.fn().mockResolvedValue({ reconciledCount: 0, jobIds: [] });
      const refresh = vi.fn().mockResolvedValue({ refreshed: true, from: "SAMPLING", to: "SAMPLE_REVIEW" });
      const logger = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await executeCampaignTickRun({ db, reconcile, enforceDeadlines, reconcileSends, refresh, logger });

      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(enforceDeadlines).toHaveBeenCalledTimes(1);
      expect(reconcileSends).toHaveBeenCalledTimes(1);
      expect(db.campaign.findMany).toHaveBeenCalledWith({
        where: { status: { in: ["SAMPLING", "GENERATING", "EXCEPTION_REVIEW", "SCHEDULED", "SENDING"] } },
        select: { id: true, status: true },
      });
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(refresh).toHaveBeenCalledWith("c1", expect.objectContaining({ db }));
      expect(refresh).toHaveBeenCalledWith("c2", expect.objectContaining({ db }));
      expect(refresh).toHaveBeenCalledWith("c3", expect.objectContaining({ db }));

      // Verifies info logs contain counts and transition names
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("2 generation drafts"));
    });

    it("calls enforceDeadlines before refreshCampaign during the tick", async () => {
      const order: string[] = [];
      const db = {
        campaign: {
          findMany: vi.fn().mockResolvedValue([{ id: "c1", status: "SAMPLING" }]),
        },
      } as any;
      const reconcile = vi.fn().mockResolvedValue({ reconciledCount: 0, draftIds: [] });
      const enforceDeadlines = vi.fn().mockImplementation(async () => {
        order.push("enforceDeadlines");
        return { processedCampaigns: 1, cancelledCampaigns: 0, resolvedDrafts: 0 };
      });
      const refresh = vi.fn().mockImplementation(async () => {
        order.push("refresh");
        return { refreshed: false };
      });
      const reconcileSends = vi.fn().mockResolvedValue({ reconciledCount: 0, jobIds: [] });
      const logger = { info: vi.fn(), error: vi.fn() };

      await executeCampaignTickRun({ db, reconcile, enforceDeadlines, refresh, reconcileSends, logger });

      expect(order).toEqual(["enforceDeadlines", "refresh"]);
      expect(enforceDeadlines).toHaveBeenCalledTimes(1);
    });

    it("calls reconcileSends during the tick", async () => {
      const db = {
        campaign: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      } as any;

      const reconcile = vi.fn().mockResolvedValue({ reconciledCount: 0, draftIds: [] });
      const reconcileSends = vi.fn().mockResolvedValue({ reconciledCount: 1, jobIds: ["j1"] });
      const refresh = vi.fn().mockResolvedValue({ refreshed: false });
      const logger = { info: vi.fn(), error: vi.fn() };

      await executeCampaignTickRun({ db, reconcile, reconcileSends, refresh, logger });

      expect(reconcileSends).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("1 send jobs"));
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
      const reconcileSends = vi.fn().mockResolvedValue({ reconciledCount: 0, jobIds: [] });
      const refresh = vi.fn()
        .mockRejectedValueOnce(new TypeError("Network error"))
        .mockResolvedValueOnce({ refreshed: true, from: "GENERATING", to: "SCHEDULED" });

      const logger = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await executeCampaignTickRun({ db, reconcile, reconcileSends, refresh, logger });

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
      const reconcileSends = vi.fn().mockResolvedValue({ reconciledCount: 0, jobIds: [] });
      const refresh = vi.fn().mockResolvedValue({ refreshed: false });
      const logger = {
        info: vi.fn(),
        error: vi.fn(),
      };

      await executeCampaignTickRun({ db, reconcile, reconcileSends, refresh, logger });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/\[CampaignTick\] Reconcile error: DatabaseTimeoutError/)
      );
      expect(refresh).toHaveBeenCalledWith("c1", expect.objectContaining({ db }));
    });

    describe("end-to-end deadline tick", () => {
      const scheduledAt = new Date("2026-11-01T12:00:00Z");
      const pastDeadline = new Date("2026-11-01T11:59:00Z");
      const finalizeLeadMs = 120_000; // 2 min lead, deadline was 11:58:00

      it("GENERATING campaign with stuck and flagged drafts reaches SCHEDULED at deadline under FALLBACK_TO_PLAIN", async () => {
        const db = createFakeDb({
          campaigns: [
            {
              id: "c1",
              status: "GENERATING",
              scheduledAt,
              onUnresolved: "FALLBACK_TO_PLAIN",
              promptFingerprint: "fp1",
              subjectTemplate: "Hello {{first_name}}",
              bodyTemplate: "{{ai_intro}}\nWelcome!",
              linkUrl: "https://example.com",
              unsubscribeUrl: "https://example.com/unsub",
              userId: "user-1",
            },
          ],
          recipients: [
            { id: "r1", campaignId: "c1", firstName: "Alice", email: "alice@example.com" },
            { id: "r2", campaignId: "c1", firstName: "Bob", email: "bob@example.com" },
            { id: "r3", campaignId: "c1", firstName: "Charlie", email: "charlie@example.com" },
          ],
          drafts: [
            { id: "d1", campaignId: "c1", recipientId: "r1", status: "PENDING", promptVersion: "fp1", emailJobId: null },
            { id: "d2", campaignId: "c1", recipientId: "r2", status: "FLAGGED", promptVersion: "fp1", emailJobId: null, flagReasons: [{ code: "TONE" }] },
            { id: "d3", campaignId: "c1", recipientId: "r3", status: "READY", promptVersion: "fp1", emailJobId: null, subject: "Sub", body: "Body" },
          ],
        });

        const reconcile = vi.fn().mockResolvedValue({ reconciledCount: 0, draftIds: [] });
        const reconcileSends = vi.fn().mockResolvedValue({ reconciledCount: 0, jobIds: [] });

        await executeCampaignTickRun({
          db,
          clock: { now: () => pastDeadline },
          ai: { finalizeLeadMs } as any,
          reconcile,
          reconcileSends,
        });

        // Campaign reached SCHEDULED
        expect(db._state.campaigns.get("c1").status).toBe("SCHEDULED");

        // d1 resolved to FALLBACK with GENERATION_INCOMPLETE_AT_DEADLINE, then QUEUED with EmailJob
        const d1 = db._state.drafts.get("d1");
        expect(d1.fallbackReason).toBe("GENERATION_INCOMPLETE_AT_DEADLINE");
        expect(d1.status).toBe("QUEUED");
        expect(d1.emailJobId).toBeTruthy();

        // d2 resolved to FALLBACK with UNRESOLVED_AT_DEADLINE, then QUEUED with EmailJob
        const d2 = db._state.drafts.get("d2");
        expect(d2.fallbackReason).toBe("UNRESOLVED_AT_DEADLINE");
        expect(d2.status).toBe("QUEUED");
        expect(d2.emailJobId).toBeTruthy();

        // d3 QUEUED with EmailJob
        const d3 = db._state.drafts.get("d3");
        expect(d3.status).toBe("QUEUED");
        expect(d3.emailJobId).toBeTruthy();

        // All 3 drafts got EmailJobs created
        expect(db._state.emailJobs.size).toBe(3);
      });

      it("GENERATING campaign with stuck and flagged drafts reaches SCHEDULED at deadline under HOLD (only non-held drafts get EmailJobs)", async () => {
        const db = createFakeDb({
          campaigns: [
            {
              id: "c1",
              status: "GENERATING",
              scheduledAt,
              onUnresolved: "HOLD",
              promptFingerprint: "fp1",
              subjectTemplate: "Hello {{first_name}}",
              bodyTemplate: "{{ai_intro}}\nWelcome!",
              linkUrl: "https://example.com",
              unsubscribeUrl: "https://example.com/unsub",
              userId: "user-1",
            },
          ],
          recipients: [
            { id: "r1", campaignId: "c1", firstName: "Alice", email: "alice@example.com" },
            { id: "r2", campaignId: "c1", firstName: "Bob", email: "bob@example.com" },
            { id: "r3", campaignId: "c1", firstName: "Charlie", email: "charlie@example.com" },
          ],
          drafts: [
            { id: "d1", campaignId: "c1", recipientId: "r1", status: "PENDING", promptVersion: "fp1", emailJobId: null },
            { id: "d2", campaignId: "c1", recipientId: "r2", status: "FLAGGED", promptVersion: "fp1", emailJobId: null, flagReasons: [{ code: "TONE" }] },
            { id: "d3", campaignId: "c1", recipientId: "r3", status: "READY", promptVersion: "fp1", emailJobId: null, subject: "Sub", body: "Body" },
          ],
        });

        const reconcile = vi.fn().mockResolvedValue({ reconciledCount: 0, draftIds: [] });
        const reconcileSends = vi.fn().mockResolvedValue({ reconciledCount: 0, jobIds: [] });

        await executeCampaignTickRun({
          db,
          clock: { now: () => pastDeadline },
          ai: { finalizeLeadMs } as any,
          reconcile,
          reconcileSends,
        });

        // Campaign reached SCHEDULED
        expect(db._state.campaigns.get("c1").status).toBe("SCHEDULED");

        // d1 resolved to HELD, does NOT have emailJobId
        const d1 = db._state.drafts.get("d1");
        expect(d1.status).toBe("HELD");
        expect(d1.emailJobId).toBeNull();

        // d2 resolved to HELD, does NOT have emailJobId
        const d2 = db._state.drafts.get("d2");
        expect(d2.status).toBe("HELD");
        expect(d2.emailJobId).toBeNull();

        // Only d3 (non-held draft) got an EmailJob and moved to QUEUED
        const d3 = db._state.drafts.get("d3");
        expect(d3.status).toBe("QUEUED");
        expect(d3.emailJobId).toBeTruthy();

        // Exactly 1 EmailJob was created (for d3)
        expect(db._state.emailJobs.size).toBe(1);
      });
    });

    it("calls finishCancellations before reconcileSends during the tick", async () => {
      const order: string[] = [];
      const db = {
        campaign: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      } as any;
      const reconcile = vi.fn().mockResolvedValue({ reconciledCount: 0, draftIds: [] });
      const enforceDeadlines = vi.fn().mockResolvedValue({ processedCampaigns: 0, cancelledCampaigns: 0, resolvedDrafts: 0 });
      const refresh = vi.fn().mockResolvedValue({ refreshed: false });
      const finishCancellations = vi.fn().mockImplementation(async () => {
        order.push("finishCancellations");
        return { processedCount: 0 };
      });
      const reconcileSends = vi.fn().mockImplementation(async () => {
        order.push("reconcileSends");
        return { reconciledCount: 0, jobIds: [] };
      });
      const logger = { info: vi.fn(), error: vi.fn() };

      await executeCampaignTickRun({
        db,
        reconcile,
        enforceDeadlines,
        refresh,
        finishCancellations,
        reconcileSends,
        logger,
      });

      expect(order).toEqual(["finishCancellations", "reconcileSends"]);
      expect(finishCancellations).toHaveBeenCalledTimes(1);
    });

    it("logs error class only when finishCancellations throws, and still runs reconcileSends", async () => {
      class CleanupCrashError extends Error {
        constructor() {
          super("database connection dropped");
          this.name = "CleanupCrashError";
        }
      }

      const db = {
        campaign: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      } as any;

      const reconcile = vi.fn().mockResolvedValue({ reconciledCount: 0, draftIds: [] });
      const finishCancellations = vi.fn().mockRejectedValue(new CleanupCrashError());
      const reconcileSends = vi.fn().mockResolvedValue({ reconciledCount: 0, jobIds: [] });
      const refresh = vi.fn().mockResolvedValue({ refreshed: false });
      const logger = { info: vi.fn(), error: vi.fn() };

      await executeCampaignTickRun({
        db,
        reconcile,
        finishCancellations,
        reconcileSends,
        refresh,
        logger,
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/\[CampaignTick\] Finish cancellations error: CleanupCrashError/)
      );
      expect(reconcileSends).toHaveBeenCalledTimes(1);
    });

    it("campaign CANCELLED with pending rows and queue jobs (simulating a crash after step a) is cleaned up by one tick run, and a following reconcileSends adds nothing", async () => {
      const removedQueueJobs: string[] = [];
      const getJob = vi.fn(async (id: string) => ({
        getState: async () => "delayed",
        remove: vi.fn(async () => {
          removedQueueJobs.push(id);
        }),
      }));

      const db = createFakeDb({
        campaigns: [
          {
            id: "c-cancelled",
            status: "CANCELLED",
            userId: "u1",
            scheduledAt: new Date("2026-12-01T12:00:00Z"),
            promptFingerprint: "fp1",
          },
        ],
        drafts: [
          {
            id: "d1",
            campaignId: "c-cancelled",
            recipientId: "r1",
            status: "QUEUED",
            promptVersion: "fp1",
            emailJobId: "job-1",
          },
        ],
        emailJobs: [
          {
            id: "job-1",
            status: "pending",
          },
        ],
      });

      const reconcile = vi.fn().mockResolvedValue({ reconciledCount: 0, draftIds: [] });
      const addedSendJobs: any[] = [];
      const addJob = vi.fn(async (name, data, opts) => {
        addedSendJobs.push({ name, data, opts });
      });

      // Run executeCampaignTickRun with real finishCancellations and reconcileSends
      await executeCampaignTickRun({
        db,
        getJob,
        reconcile,
        reconcileSends: (cId, deps) =>
          import("./reconcile").then((m) =>
            m.reconcileSends(cId, { ...deps, db, getJob, addJob })
          ),
      });

      // The EmailJob row was deleted
      expect(db._state.emailJobs.has("job-1")).toBe(false);

      // Draft was updated to HELD and its emailJobId SetNull
      const d1 = db._state.drafts.get("d1");
      expect(d1.status).toBe("HELD");
      expect(d1.emailJobId).toBeNull();

      // Queue job was removed
      expect(removedQueueJobs).toEqual(["job-1"]);

      // Following reconcileSends added nothing
      expect(addedSendJobs).toHaveLength(0);
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
        reconcileSends: vi.fn().mockResolvedValue({ reconciledCount: 0, jobIds: [] }),
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

      const reconcileSends = vi.fn().mockResolvedValue({ reconciledCount: 0, jobIds: [] });
      const stop = startCampaignTick({ intervalMs: 1000 }, { db, reconcile, reconcileSends });

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
        reconcileSends: vi.fn().mockResolvedValue({ reconciledCount: 0, jobIds: [] }),
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
