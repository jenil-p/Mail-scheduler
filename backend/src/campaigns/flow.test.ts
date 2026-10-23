import { describe, expect, it, vi } from "vitest";
import {
  approveSamples,
  EmptyCampaignError,
  InvalidInstructionError,
  refreshCampaign,
  regenerateSamples,
  scheduleCampaign,
  startPlainCampaign,
  startSampling,
  type FlowDeps,
  type FlowEnqueueItem,
} from "./flow";
import { reconcileSends } from "./reconcile";
import { IllegalTransitionError } from "./stateMachine";
import { createDailyUsageGetter } from "./budget";
import type { CampaignStatus } from "../generated/prisma/client";

// In-memory Prisma fake for unit testing flow transactions and preconditions
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
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const c = campaigns.get(where.id);
        return c ? { ...c } : null;
      }),
      findMany: vi.fn(async () => Array.from(campaigns.values()).map((c) => ({ ...c }))),
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
      findMany: vi.fn(async ({ where, include }: { where: any; include?: any }) => {
        let list = Array.from(drafts.values());
        if (where.campaignId) {
          list = list.filter((d) => d.campaignId === where.campaignId);
        }
        if (where.promptVersion) {
          list = list.filter((d) => d.promptVersion === where.promptVersion);
        }
        if (where.isSample !== undefined) {
          list = list.filter((d) => d.isSample === where.isSample);
        }
        if (where.emailJobId === null) {
          list = list.filter((d) => !d.emailJobId);
        }
        if (where.status) {
          if (typeof where.status === "string") {
            list = list.filter((d) => d.status === where.status);
          } else if (where.status.in) {
            list = list.filter((d) => where.status.in.includes(d.status));
          }
        }
        return list.map((d) => {
          const res = { ...d };
          if (include?.recipient) {
            if ("recipient" in d) {
              res.recipient = d.recipient;
            } else if (d.recipientId && !recipients.has(d.recipientId)) {
              res.recipient = null;
            } else {
              res.recipient = recipients.get(d.recipientId) ?? {
                id: d.recipientId ?? "r1",
                email: `${d.recipientId ?? "r1"}@example.com`,
              };
            }
          }
          return res;
        });
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string; status?: any; emailJobId?: any }; data: any }) => {
        const existing = drafts.get(where.id);
        if (!existing) {
          const err = new Error(`Draft ${where.id} not found`);
          (err as any).code = "P2025";
          throw err;
        }
        if (where.status !== undefined && existing.status !== where.status) {
          const err = new Error(`Record to update not found (status precondition failed)`);
          (err as any).code = "P2025";
          throw err;
        }
        if ((where.emailJobId === null || (where as any).emailJob === null) && existing.emailJobId != null) {
          const err = new Error(`Record to update not found (emailJobId precondition failed)`);
          (err as any).code = "P2025";
          throw err;
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
      count: vi.fn(async ({ where }: { where: any }) => {
        let list = Array.from(drafts.values());
        if (where.campaignId) {
          list = list.filter((d) => d.campaignId === where.campaignId);
        }
        if (where.promptVersion) {
          list = list.filter((d) => d.promptVersion === where.promptVersion);
        }
        if (where.isSample !== undefined) {
          list = list.filter((d) => d.isSample === where.isSample);
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
      createMany: vi.fn(async ({ data }: { data: any[] }) => {
        let count = 0;
        for (const item of data) {
          if (!drafts.has(item.id)) {
            drafts.set(item.id, { ...item });
            count++;
          }
        }
        return { count };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { campaignId: string } }) => {
        let count = 0;
        for (const [id, d] of drafts.entries()) {
          if (d.campaignId === where.campaignId) {
            drafts.delete(id);
            count++;
          }
        }
        return { count };
      }),
    },
    emailJob: {
      findMany: vi.fn(async ({ where }: { where?: any }) => {
        let list = Array.from(emailJobs.values());
        if (where?.status) {
          if (typeof where.status === "string") {
            list = list.filter((j) => j.status === where.status);
          } else if (where.status.in) {
            list = list.filter((j) => where.status.in.includes(j.status));
          }
        }
        if (where?.generatedDraft?.campaignId) {
          const cId = where.generatedDraft.campaignId;
          const targetIds = cId.in ? cId.in : [cId];
          list = list.filter((j) => {
            const draft = Array.from(drafts.values()).find((d) => d.emailJobId === j.id);
            return draft && targetIds.includes(draft.campaignId);
          });
        }
        return list.map((j) => ({ ...j }));
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const j = emailJobs.get(where.id);
        return j ? { ...j } : null;
      }),
      count: vi.fn(async ({ where }: { where?: any }) => {
        let list = Array.from(emailJobs.values());
        if (where?.status) {
          if (typeof where.status === "string") {
            list = list.filter((j) => j.status === where.status);
          } else if (where.status.in) {
            list = list.filter((j) => where.status.in.includes(j.status));
          }
        }
        if (where?.generatedDraft) {
          const cId = where.generatedDraft.campaignId;
          const pVer = where.generatedDraft.promptVersion;
          list = list.filter((j) => {
            const draft = Array.from(drafts.values()).find((d) => d.emailJobId === j.id);
            if (!draft) return false;
            if (cId && draft.campaignId !== cId) return false;
            if (pVer && draft.promptVersion !== pVer) return false;
            return true;
          });
        }
        return list.length;
      }),
    },
    $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => {
      return cb(client);
    }),
    _state: { campaigns, recipients, drafts, emailJobs },
  };

  return client as any;
}

describe("flow", () => {
  const defaultIdentity = {
    promptTemplateVersion: "personalize.v2",
    llmModel: "mock-model",
  };

  describe("startSampling", () => {
    it("freezes identity, selects samples, creates sample drafts, and moves DRAFT -> SAMPLING", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "DRAFT",
            aiEnabled: true,
            aiInstruction: "Be polite.",
            templateHash: "thash1",
          },
        ],
        recipients: [
          { id: "r1", campaignId: "c1", company: "Acme", role: "Dev", note: "VIP", hasPersonalizationData: true },
          { id: "r2", campaignId: "c1", company: "Beta", role: "Dev", hasPersonalizationData: true },
          { id: "r3", campaignId: "c1", company: "Gamma", hasPersonalizationData: true },
          { id: "r4", campaignId: "c1", firstName: "Thin", hasPersonalizationData: false },
        ],
      });

      const enqueuedJobs: FlowEnqueueItem[] = [];
      const deps: FlowDeps = {
        db,
        identity: defaultIdentity,
        sampleSize: 3,
        enqueue: async (jobs) => {
          enqueuedJobs.push(...jobs);
        },
      };

      const result = await startSampling("c1", deps);

      expect(result.ok).toBe(true);
      expect(result.draftIds.length).toBeGreaterThan(0);

      const campaign = db._state.campaigns.get("c1");
      expect(campaign.status).toBe("SAMPLING");
      expect(campaign.promptFingerprint).toBeTruthy();
      expect(campaign.llmModel).toBe("mock-model");
      expect(campaign.promptTemplateVersion).toBe("personalize.v2");

      // Verify drafts in DB
      const drafts = Array.from(db._state.drafts.values()) as any[];
      expect(drafts.length).toBe(3);
      for (const d of drafts) {
        expect(d.campaignId).toBe("c1");
        expect(d.isSample).toBe(true);
        expect(d.status).toBe("PENDING");
        expect(d.promptVersion).toBe(campaign.promptFingerprint);
      }

      // Verify jobs enqueued after commit
      expect(enqueuedJobs).toHaveLength(3);
      expect(enqueuedJobs.every((j) => j.isSample)).toBe(true);
    });

    it("throws IllegalTransitionError when called from any status other than DRAFT", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "SAMPLE_REVIEW",
            aiEnabled: true,
            templateHash: "thash1",
          },
        ],
      });

      await expect(startSampling("c1", { db, identity: defaultIdentity })).rejects.toThrow(
        IllegalTransitionError
      );
    });

    it("rejects when aiEnabled is false", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "DRAFT",
            aiEnabled: false,
            templateHash: "thash1",
          },
        ],
      });

      await expect(startSampling("c1", { db, identity: defaultIdentity })).rejects.toThrow(
        /AI personalization disabled/
      );
    });

    it("throws EmptyCampaignError (code EMPTY_CAMPAIGN) before changing anything if campaign has zero recipients", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "DRAFT",
            aiEnabled: true,
            templateHash: "thash1",
          },
        ],
        recipients: [],
      });

      let err: any;
      try {
        await startSampling("c1", { db, identity: defaultIdentity });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(EmptyCampaignError);
      expect(err.code).toBe("EMPTY_CAMPAIGN");

      // Verify DB remains completely unchanged
      const campaign = db._state.campaigns.get("c1");
      expect(campaign.status).toBe("DRAFT");
      expect(campaign.promptFingerprint).toBeUndefined();
      expect(db._state.drafts.size).toBe(0);
    });

    it("leaves drafts PENDING in database and resolves ok if enqueue throws after commit", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "DRAFT",
            aiEnabled: true,
            templateHash: "thash1",
          },
        ],
        recipients: [
          { id: "r1", campaignId: "c1", company: "Acme", hasPersonalizationData: true },
        ],
      });

      const logger = { error: vi.fn(), info: vi.fn() };
      const deps: FlowDeps = {
        db,
        identity: defaultIdentity,
        logger,
        enqueue: async () => {
          throw new TypeError("Redis connection dropped");
        },
      };

      const result = await startSampling("c1", deps);
      expect(result.ok).toBe(true);
      expect(result.draftIds).toHaveLength(1);
      expect(logger.error).toHaveBeenCalledWith("[Flow] enqueue failed: TypeError");

      // State moved to SAMPLING and drafts exist as PENDING
      const campaign = db._state.campaigns.get("c1");
      expect(campaign.status).toBe("SAMPLING");

      const drafts = Array.from(db._state.drafts.values()) as any[];
      expect(drafts).toHaveLength(1);
      expect(drafts[0].status).toBe("PENDING");
    });
  });

  describe("regenerateSamples", () => {
    it("deletes old drafts, stores new fingerprint, and transitions SAMPLE_REVIEW -> SAMPLING", async () => {
      const oldFingerprint = "old-fingerprint-1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "SAMPLE_REVIEW",
            aiEnabled: true,
            aiInstruction: "Old style",
            promptFingerprint: oldFingerprint,
            templateHash: "thash1",
          },
        ],
        recipients: [
          { id: "r1", campaignId: "c1", company: "Acme", hasPersonalizationData: true },
        ],
        drafts: [
          {
            id: "old-draft-1",
            campaignId: "c1",
            recipientId: "r1",
            promptVersion: oldFingerprint,
            status: "READY",
            isSample: true,
          },
        ],
      });

      const enqueuedJobs: FlowEnqueueItem[] = [];
      const deps: FlowDeps = {
        db,
        identity: defaultIdentity,
        enqueue: async (jobs) => {
          enqueuedJobs.push(...jobs);
        },
      };

      const result = await regenerateSamples("c1", { aiInstruction: "New concise style" }, deps);

      expect(result.ok).toBe(true);
      const campaign = db._state.campaigns.get("c1");
      expect(campaign.status).toBe("SAMPLING");
      expect(campaign.aiInstruction).toBe("New concise style");
      expect(campaign.promptFingerprint).not.toBe(oldFingerprint);

      // Old drafts deleted, new draft created
      expect(db._state.drafts.has("old-draft-1")).toBe(false);
      const newDrafts = Array.from(db._state.drafts.values()) as any[];
      expect(newDrafts).toHaveLength(1);
      expect(newDrafts[0].promptVersion).toBe(campaign.promptFingerprint);
      expect(enqueuedJobs).toHaveLength(1);
    });

    it("rejects over-long instruction with InvalidInstructionError (INVALID_INSTRUCTION)", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "SAMPLE_REVIEW",
            aiEnabled: true,
            templateHash: "thash1",
          },
        ],
      });

      const longInstruction = "a".repeat(501);
      await expect(
        regenerateSamples("c1", { aiInstruction: longInstruction }, { db, instructionMaxLength: 500 })
      ).rejects.toThrow(InvalidInstructionError);
    });

    it("clears instruction to null when explicit empty string is passed", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "SAMPLE_REVIEW",
            aiEnabled: true,
            aiInstruction: "Something",
            templateHash: "thash1",
          },
        ],
        recipients: [
          { id: "r1", campaignId: "c1", company: "Acme", hasPersonalizationData: true },
        ],
      });

      await regenerateSamples("c1", { aiInstruction: "   " }, { db, identity: defaultIdentity, enqueue: async () => {} });

      const campaign = db._state.campaigns.get("c1");
      expect(campaign.aiInstruction).toBeNull();
      expect(campaign.status).toBe("SAMPLING");
    });

    it("keeps existing instruction when aiInstruction option is omitted", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "SAMPLE_REVIEW",
            aiEnabled: true,
            aiInstruction: "Keep this instruction",
            templateHash: "thash1",
          },
        ],
        recipients: [
          { id: "r1", campaignId: "c1", company: "Acme", hasPersonalizationData: true },
        ],
      });

      await regenerateSamples("c1", {}, { db, identity: defaultIdentity, enqueue: async () => {} });

      const campaign = db._state.campaigns.get("c1");
      expect(campaign.aiInstruction).toBe("Keep this instruction");
    });

    it("throws IllegalTransitionError if called outside SAMPLE_REVIEW", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "GENERATING",
            aiEnabled: true,
          },
        ],
      });

      await expect(regenerateSamples("c1", {}, { db })).rejects.toThrow(IllegalTransitionError);
    });

    it("leaves drafts PENDING in database and resolves ok if enqueue throws after commit", async () => {
      const oldFingerprint = "old-fp";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "SAMPLE_REVIEW",
            aiEnabled: true,
            promptFingerprint: oldFingerprint,
            templateHash: "thash1",
          },
        ],
        recipients: [
          { id: "r1", campaignId: "c1", company: "Acme", hasPersonalizationData: true },
        ],
        drafts: [
          { id: "d1", campaignId: "c1", recipientId: "r1", promptVersion: oldFingerprint, isSample: true, status: "READY" },
        ],
      });

      const logger = { error: vi.fn(), info: vi.fn() };
      const deps: FlowDeps = {
        db,
        identity: defaultIdentity,
        logger,
        enqueue: async () => {
          throw new RangeError("BullMQ queue error");
        },
      };

      const result = await regenerateSamples("c1", {}, deps);
      expect(result.ok).toBe(true);
      expect(logger.error).toHaveBeenCalledWith("[Flow] enqueue failed: RangeError");

      const campaign = db._state.campaigns.get("c1");
      expect(campaign.status).toBe("SAMPLING");
      expect(db._state.drafts.size).toBe(1);
      const drafts = Array.from(db._state.drafts.values()) as any[];
      expect(drafts[0].status).toBe("PENDING");
    });
  });

  describe("approveSamples", () => {
    it("returns BUDGET_WARNING without changing anything when needed > remaining and not acknowledged", async () => {
      const fingerprint = "fp1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "SAMPLE_REVIEW",
            promptFingerprint: fingerprint,
            llmModel: "mock-model",
            templateHash: "thash1",
          },
        ],
        recipients: [
          { id: "r1", campaignId: "c1", hasPersonalizationData: true }, // sample draft exists
          { id: "r2", campaignId: "c1", hasPersonalizationData: true }, // needed
          { id: "r3", campaignId: "c1", hasPersonalizationData: true }, // needed
          { id: "r4", campaignId: "c1", hasPersonalizationData: false }, // thin data (no model call needed)
        ],
        drafts: [
          {
            id: "d1",
            campaignId: "c1",
            recipientId: "r1",
            promptVersion: fingerprint,
            isSample: true,
            status: "READY",
          },
        ],
      });

      // needed = 2 (r2 and r3). remaining = 10 - 9 = 1.
      const result = await approveSamples(
        "c1",
        { acknowledgeBudgetWarning: false },
        { db, dailyLimit: 10, dailyUsage: 9 }
      );

      expect(result).toEqual({
        ok: false,
        code: "BUDGET_WARNING",
        needed: 2,
        remaining: 1,
      });

      // No state change and no new drafts
      const campaign = db._state.campaigns.get("c1");
      expect(campaign.status).toBe("SAMPLE_REVIEW");
      expect(campaign.approvedPromptVersion).toBeUndefined();
      expect(db._state.drafts.size).toBe(1);
    });

    it("throws Error when daily limit is configured without dailyUsage or getDailyUsage", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "SAMPLE_REVIEW",
            promptFingerprint: "fp1",
            llmModel: "mock-model",
            templateHash: "thash1",
          },
        ],
        recipients: [{ id: "r1", campaignId: "c1", hasPersonalizationData: true }],
      });

      await expect(
        approveSamples("c1", {}, { db, dailyLimit: 100 })
      ).rejects.toThrow("approveSamples needs a daily usage source when a daily limit is configured");
    });

    it("queries daily usage via createDailyUsageGetter when daily limit is configured", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "SAMPLE_REVIEW",
            promptFingerprint: "fp1",
            llmModel: "mock-model",
            templateHash: "thash1",
          },
        ],
        recipients: [
          { id: "r1", campaignId: "c1", hasPersonalizationData: true },
          { id: "r2", campaignId: "c1", hasPersonalizationData: true },
        ],
        drafts: [
          {
            id: "d1",
            campaignId: "c1",
            recipientId: "r1",
            promptVersion: "fp1",
            isSample: true,
            status: "READY",
          },
        ],
      });

      const limiter = {
        dailyUsage: vi.fn().mockResolvedValue(99),
      };
      const getDailyUsage = createDailyUsageGetter(limiter, "mock");

      // needed = 1 (r2). dailyLimit = 100, usage = 99 -> remaining = 1.
      // needed (1) <= remaining (1) -> passes budget check without warning.
      const result = await approveSamples(
        "c1",
        { acknowledgeBudgetWarning: false },
        { db, dailyLimit: 100, getDailyUsage, enqueue: async () => {} }
      );

      expect(result).toEqual({ ok: true });
      expect(limiter.dailyUsage).toHaveBeenCalledWith("mock", "mock-model");
    });

    it("fans out drafts and sets GENERATING when budget check passes or is acknowledged", async () => {
      const fingerprint = "fp1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "SAMPLE_REVIEW",
            promptFingerprint: fingerprint,
            llmModel: "mock-model",
            templateHash: "thash1",
          },
        ],
        recipients: [
          { id: "r1", campaignId: "c1", hasPersonalizationData: true }, // sample draft
          { id: "r2", campaignId: "c1", hasPersonalizationData: true },
          { id: "r3", campaignId: "c1", hasPersonalizationData: false }, // thin data included
        ],
        drafts: [
          {
            id: "d1",
            campaignId: "c1",
            recipientId: "r1",
            promptVersion: fingerprint,
            isSample: true,
            status: "READY",
          },
        ],
      });

      const enqueuedJobs: FlowEnqueueItem[] = [];
      const result = await approveSamples(
        "c1",
        { acknowledgeBudgetWarning: true },
        {
          db,
          dailyLimit: 10,
          dailyUsage: 9,
          enqueue: async (jobs) => {
            enqueuedJobs.push(...jobs);
          },
        }
      );

      expect(result).toEqual({ ok: true });

      const campaign = db._state.campaigns.get("c1");
      expect(campaign.status).toBe("GENERATING");
      expect(campaign.approvedPromptVersion).toBe(fingerprint);

      // Drafts created for r2 and r3 (total 3 drafts)
      expect(db._state.drafts.size).toBe(3);
      expect(enqueuedJobs).toHaveLength(2);
      expect(enqueuedJobs.every((j) => !j.isSample)).toBe(true);
    });

    it("calling approveSamples twice does not create duplicates or allow second transition", async () => {
      const fingerprint = "fp1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "SAMPLE_REVIEW",
            promptFingerprint: fingerprint,
            templateHash: "thash1",
          },
        ],
        recipients: [{ id: "r1", campaignId: "c1", hasPersonalizationData: true }],
      });

      await approveSamples("c1", {}, { db, enqueue: async () => {} });
      expect(db._state.drafts.size).toBe(1);

      // Second call fails because campaign is now GENERATING
      await expect(approveSamples("c1", {}, { db, enqueue: async () => {} })).rejects.toThrow(
        IllegalTransitionError
      );
      expect(db._state.drafts.size).toBe(1);
    });

    it("leaves drafts PENDING in database and resolves ok if enqueue throws after commit", async () => {
      const fingerprint = "fp1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "SAMPLE_REVIEW",
            promptFingerprint: fingerprint,
            llmModel: "mock-model",
            templateHash: "thash1",
          },
        ],
        recipients: [
          { id: "r1", campaignId: "c1", hasPersonalizationData: true },
          { id: "r2", campaignId: "c1", hasPersonalizationData: true },
        ],
        drafts: [
          {
            id: "d1",
            campaignId: "c1",
            recipientId: "r1",
            promptVersion: fingerprint,
            isSample: true,
            status: "READY",
          },
        ],
      });

      const logger = { error: vi.fn(), info: vi.fn() };
      const result = await approveSamples(
        "c1",
        { acknowledgeBudgetWarning: true },
        {
          db,
          logger,
          enqueue: async () => {
            throw new Error("Redis write failure");
          },
        }
      );

      expect(result).toEqual({ ok: true });
      expect(logger.error).toHaveBeenCalledWith("[Flow] enqueue failed: Error");

      const campaign = db._state.campaigns.get("c1");
      expect(campaign.status).toBe("GENERATING");
      expect(db._state.drafts.size).toBe(2);
      const drafts = Array.from(db._state.drafts.values()) as any[];
      const remainingDraft = drafts.find((d) => d.recipientId === "r2");
      expect(remainingDraft?.status).toBe("PENDING");
    });
  });

  describe("refreshCampaign", () => {
    it("moves SAMPLING -> SAMPLE_REVIEW when every sample draft is READY, FLAGGED or FALLBACK", async () => {
      const fingerprint = "fp1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "SAMPLING",
            promptFingerprint: fingerprint,
          },
        ],
        drafts: [
          { id: "d1", campaignId: "c1", promptVersion: fingerprint, isSample: true, status: "READY" },
          { id: "d2", campaignId: "c1", promptVersion: fingerprint, isSample: true, status: "FLAGGED" },
          { id: "d3", campaignId: "c1", promptVersion: fingerprint, isSample: true, status: "FALLBACK" },
        ],
      });

      const outcome = await refreshCampaign("c1", { db });

      expect(outcome).toEqual({
        refreshed: true,
        from: "SAMPLING",
        to: "SAMPLE_REVIEW",
      });
      expect(db._state.campaigns.get("c1").status).toBe("SAMPLE_REVIEW");
    });

    it("does not advance SAMPLING if any sample draft is still PENDING or GENERATING", async () => {
      const fingerprint = "fp1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "SAMPLING",
            promptFingerprint: fingerprint,
          },
        ],
        drafts: [
          { id: "d1", campaignId: "c1", promptVersion: fingerprint, isSample: true, status: "READY" },
          { id: "d2", campaignId: "c1", promptVersion: fingerprint, isSample: true, status: "PENDING" },
        ],
      });

      const outcome = await refreshCampaign("c1", { db });

      expect(outcome.refreshed).toBe(false);
      expect(db._state.campaigns.get("c1").status).toBe("SAMPLING");
    });

    it("moves GENERATING -> EXCEPTION_REVIEW if any draft is FLAGGED", async () => {
      const fingerprint = "fp1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "GENERATING",
            promptFingerprint: fingerprint,
          },
        ],
        recipients: [{ id: "r1", campaignId: "c1" }, { id: "r2", campaignId: "c1" }],
        drafts: [
          { id: "d1", campaignId: "c1", promptVersion: fingerprint, status: "READY" },
          { id: "d2", campaignId: "c1", promptVersion: fingerprint, status: "FLAGGED" },
        ],
      });

      const outcome = await refreshCampaign("c1", { db });

      expect(outcome).toEqual({
        refreshed: true,
        from: "GENERATING",
        to: "EXCEPTION_REVIEW",
      });
      expect(db._state.campaigns.get("c1").status).toBe("EXCEPTION_REVIEW");
    });

    it("moves GENERATING -> SCHEDULED via scheduleCampaign seam when none is FLAGGED", async () => {
      const fingerprint = "fp1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "GENERATING",
            promptFingerprint: fingerprint,
          },
        ],
        recipients: [{ id: "r1", campaignId: "c1" }, { id: "r2", campaignId: "c1" }],
        drafts: [
          { id: "d1", campaignId: "c1", promptVersion: fingerprint, status: "READY" },
          { id: "d2", campaignId: "c1", promptVersion: fingerprint, status: "FALLBACK" },
        ],
      });

      const outcome = await refreshCampaign("c1", { db });

      expect(outcome).toEqual({
        refreshed: true,
        from: "GENERATING",
        to: "SCHEDULED",
      });
      expect(db._state.campaigns.get("c1").status).toBe("SCHEDULED");
    });

    it("moves EXCEPTION_REVIEW -> SCHEDULED when no FLAGGED draft remains", async () => {
      const fingerprint = "fp1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "EXCEPTION_REVIEW",
            promptFingerprint: fingerprint,
          },
        ],
        drafts: [
          { id: "d1", campaignId: "c1", promptVersion: fingerprint, status: "APPROVED" },
          { id: "d2", campaignId: "c1", promptVersion: fingerprint, status: "FALLBACK" },
        ],
      });

      const outcome = await refreshCampaign("c1", { db });

      expect(outcome).toEqual({
        refreshed: true,
        from: "EXCEPTION_REVIEW",
        to: "SCHEDULED",
      });
      expect(db._state.campaigns.get("c1").status).toBe("SCHEDULED");
    });

    it("never touches campaigns in DRAFT, SAMPLE_REVIEW, PAUSED, CANCELLED, or COMPLETED", async () => {
      for (const status of ["DRAFT", "SAMPLE_REVIEW", "PAUSED", "CANCELLED", "COMPLETED"] as CampaignStatus[]) {
        const db = createFakeDb({
          campaigns: [
            {
              id: "c1",
              status,
              promptFingerprint: "fp1",
            },
          ],
        });

        const outcome = await refreshCampaign("c1", { db });
        expect(outcome.refreshed).toBe(false);
        expect(db._state.campaigns.get("c1").status).toBe(status);
      }
    });

    describe("SCHEDULED and SENDING status progression (Phase 6b)", () => {
      it("does not advance SCHEDULED when now < scheduledAt", async () => {
        const scheduledAt = new Date("2026-10-20T12:00:00Z");
        const clock = { now: () => new Date("2026-10-20T11:59:59Z") };
        const db = createFakeDb({
          campaigns: [
            {
              id: "c1",
              status: "SCHEDULED",
              promptFingerprint: "fp1",
              scheduledAt,
            },
          ],
        });

        const outcome = await refreshCampaign("c1", { db, clock });
        expect(outcome.refreshed).toBe(false);
        expect(db._state.campaigns.get("c1").status).toBe("SCHEDULED");
      });

      it("advances SCHEDULED -> SENDING when now >= scheduledAt and pending jobs remain", async () => {
        const scheduledAt = new Date("2026-10-20T12:00:00Z");
        const clock = { now: () => new Date("2026-10-20T12:00:00Z") };
        const db = createFakeDb({
          campaigns: [
            {
              id: "c1",
              status: "SCHEDULED",
              promptFingerprint: "fp1",
              scheduledAt,
            },
          ],
          drafts: [
            { id: "d1", campaignId: "c1", promptVersion: "fp1", status: "QUEUED", emailJobId: "job-1" },
          ],
          emailJobs: [
            { id: "job-1", status: "pending" },
          ],
        });

        const outcome = await refreshCampaign("c1", { db, clock });
        expect(outcome).toEqual({
          refreshed: true,
          from: "SCHEDULED",
          to: "SENDING",
        });
        expect(db._state.campaigns.get("c1").status).toBe("SENDING");
      });

      it("advances SCHEDULED -> COMPLETED when now >= scheduledAt and all drafts are HELD", async () => {
        const scheduledAt = new Date("2026-10-20T12:00:00Z");
        const clock = { now: () => new Date("2026-10-20T12:00:05Z") };
        const db = createFakeDb({
          campaigns: [
            {
              id: "c1",
              status: "SCHEDULED",
              promptFingerprint: "fp1",
              scheduledAt,
            },
          ],
          drafts: [
            { id: "d1", campaignId: "c1", promptVersion: "fp1", status: "HELD", emailJobId: null },
            { id: "d2", campaignId: "c1", promptVersion: "fp1", status: "HELD", emailJobId: null },
          ],
        });

        const outcome = await refreshCampaign("c1", { db, clock });
        expect(outcome).toEqual({
          refreshed: true,
          from: "SCHEDULED",
          to: "COMPLETED",
        });
        expect(db._state.campaigns.get("c1").status).toBe("COMPLETED");
      });

      it("does not advance SENDING when unqueued drafts exist (emailJobId is null)", async () => {
        const db = createFakeDb({
          campaigns: [
            {
              id: "c1",
              status: "SENDING",
              promptFingerprint: "fp1",
            },
          ],
          drafts: [
            { id: "d1", campaignId: "c1", promptVersion: "fp1", status: "READY", emailJobId: null },
          ],
        });

        const outcome = await refreshCampaign("c1", { db });
        expect(outcome.refreshed).toBe(false);
        expect(db._state.campaigns.get("c1").status).toBe("SENDING");
      });

      it("does not advance SENDING when linked EmailJobs are pending or rate_limited", async () => {
        const db = createFakeDb({
          campaigns: [
            {
              id: "c1",
              status: "SENDING",
              promptFingerprint: "fp1",
            },
          ],
          drafts: [
            { id: "d1", campaignId: "c1", promptVersion: "fp1", status: "QUEUED", emailJobId: "job-1" },
            { id: "d2", campaignId: "c1", promptVersion: "fp1", status: "QUEUED", emailJobId: "job-2" },
          ],
          emailJobs: [
            { id: "job-1", status: "sent" },
            { id: "job-2", status: "rate_limited" },
          ],
        });

        const outcome = await refreshCampaign("c1", { db });
        expect(outcome.refreshed).toBe(false);
        expect(db._state.campaigns.get("c1").status).toBe("SENDING");
      });

      it("advances SENDING -> COMPLETED when all linked EmailJobs are sent or failed and no unqueued drafts", async () => {
        const db = createFakeDb({
          campaigns: [
            {
              id: "c1",
              status: "SENDING",
              promptFingerprint: "fp1",
            },
          ],
          drafts: [
            { id: "d1", campaignId: "c1", promptVersion: "fp1", status: "QUEUED", emailJobId: "job-1" },
            { id: "d2", campaignId: "c1", promptVersion: "fp1", status: "QUEUED", emailJobId: "job-2" },
          ],
          emailJobs: [
            { id: "job-1", status: "sent" },
            { id: "job-2", status: "failed" },
          ],
        });

        const outcome = await refreshCampaign("c1", { db });
        expect(outcome).toEqual({
          refreshed: true,
          from: "SENDING",
          to: "COMPLETED",
        });
        expect(db._state.campaigns.get("c1").status).toBe("COMPLETED");
      });
    });

    it("two concurrent refreshCampaign calls call scheduleCampaign exactly once", async () => {
      const fingerprint = "fp1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "GENERATING",
            promptFingerprint: fingerprint,
          },
        ],
        recipients: [{ id: "r1", campaignId: "c1" }],
        drafts: [{ id: "d1", campaignId: "c1", promptVersion: fingerprint, status: "READY" }],
      });

      // Run two concurrent refreshes
      const [res1, res2] = await Promise.all([
        refreshCampaign("c1", { db }),
        refreshCampaign("c1", { db }),
      ]);

      const successCount = [res1, res2].filter((r) => r.refreshed && r.to === "SCHEDULED").length;
      expect(successCount).toBe(1);
      expect(db._state.campaigns.get("c1").status).toBe("SCHEDULED");
    });
  });

  describe("scheduleCampaign", () => {
    it("only READY/APPROVED/FALLBACK drafts get EmailJobs; HELD and FLAGGED do not; drafts become QUEUED with emailJobId set", async () => {
      const fingerprint = "fp1";
      const scheduledAt = new Date("2026-11-01T10:00:00Z");
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            userId: "owner@example.com",
            status: "GENERATING",
            promptFingerprint: fingerprint,
            scheduledAt,
          },
        ],
        recipients: [
          { id: "r1", campaignId: "c1", email: "r1@example.com" },
          { id: "r2", campaignId: "c1", email: "r2@example.com" },
          { id: "r3", campaignId: "c1", email: "r3@example.com" },
          { id: "r4", campaignId: "c1", email: "r4@example.com" },
          { id: "r5", campaignId: "c1", email: "r5@example.com" },
        ],
        drafts: [
          { id: "d1", campaignId: "c1", recipientId: "r1", promptVersion: fingerprint, status: "READY", subject: "S1", body: "B1" },
          { id: "d2", campaignId: "c1", recipientId: "r2", promptVersion: fingerprint, status: "APPROVED", subject: "S2", body: "B2" },
          { id: "d3", campaignId: "c1", recipientId: "r3", promptVersion: fingerprint, status: "FALLBACK", subject: "S3", body: "B3" },
          { id: "d4", campaignId: "c1", recipientId: "r4", promptVersion: fingerprint, status: "HELD", subject: "S4", body: "B4" },
          { id: "d5", campaignId: "c1", recipientId: "r5", promptVersion: fingerprint, status: "FLAGGED", subject: "S5", body: "B5" },
        ],
      });

      const sendJobs: any[] = [];
      const addSendJob = vi.fn(async (job, opts) => {
        sendJobs.push({ job, opts });
      });

      const moved = await scheduleCampaign("c1", "GENERATING", { db, addSendJob });
      expect(moved).toBe(true);

      // Verify drafts status and emailJobId
      const d1 = db._state.drafts.get("d1");
      const d2 = db._state.drafts.get("d2");
      const d3 = db._state.drafts.get("d3");
      const d4 = db._state.drafts.get("d4");
      const d5 = db._state.drafts.get("d5");

      expect(d1.status).toBe("QUEUED");
      expect(d1.emailJobId).toBeDefined();
      expect(d2.status).toBe("QUEUED");
      expect(d2.emailJobId).toBeDefined();
      expect(d3.status).toBe("QUEUED");
      expect(d3.emailJobId).toBeDefined();

      // HELD and FLAGGED do not get EmailJobs and stay in their status
      expect(d4.status).toBe("HELD");
      expect(d4.emailJobId).toBeUndefined();
      expect(d5.status).toBe("FLAGGED");
      expect(d5.emailJobId).toBeUndefined();

      // Verify EmailJob content equals draft's subject and body
      const j1 = db._state.emailJobs.get(d1.emailJobId);
      expect(j1).toMatchObject({
        userId: "owner@example.com",
        recipientEmail: "r1@example.com",
        subject: "S1",
        body: "B1",
        senderEmail: "Sendly Scheduler <scheduler@sendly.local>",
        status: "pending",
      });

      const j2 = db._state.emailJobs.get(d2.emailJobId);
      expect(j2.subject).toBe("S2");
      expect(j2.body).toBe("B2");

      const j3 = db._state.emailJobs.get(d3.emailJobId);
      expect(j3.subject).toBe("S3");
      expect(j3.body).toBe("B3");

      // Verify send queue additions
      expect(sendJobs).toHaveLength(3);
    });

    it("a second call creates nothing", async () => {
      const fingerprint = "fp1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            userId: "owner@example.com",
            status: "GENERATING",
            promptFingerprint: fingerprint,
            scheduledAt: new Date(),
          },
        ],
        recipients: [{ id: "r1", campaignId: "c1", email: "r1@example.com" }],
        drafts: [
          { id: "d1", campaignId: "c1", recipientId: "r1", promptVersion: fingerprint, status: "READY", subject: "S", body: "B" },
        ],
      });

      const addSendJob = vi.fn();
      const first = await scheduleCampaign("c1", "GENERATING", { db, addSendJob });
      expect(first).toBe(true);
      expect(addSendJob).toHaveBeenCalledTimes(1);

      // Second call when campaign is already SCHEDULED
      const second = await scheduleCampaign("c1", "GENERATING", { db, addSendJob });
      expect(second).toBe(false);
      expect(addSendJob).toHaveBeenCalledTimes(1);
    });

    it("staggers email delays by CAMPAIGN_DELAY_BETWEEN_EMAILS_MS ordering by recipient createdAt then id", async () => {
      const fingerprint = "fp1";
      const scheduledAt = new Date("2026-11-01T10:00:00Z");
      const clock = { now: () => new Date("2026-11-01T09:00:00Z") }; // 3600_000 ms before scheduledAt
      const baseDelay = 3600_000;

      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            userId: "owner@example.com",
            status: "GENERATING",
            promptFingerprint: fingerprint,
            scheduledAt,
          },
        ],
        recipients: [
          { id: "r-c", campaignId: "c1", email: "rc@example.com", createdAt: new Date("2026-10-01T12:00:00Z") },
          { id: "r-a", campaignId: "c1", email: "ra@example.com", createdAt: new Date("2026-10-01T10:00:00Z") },
          { id: "r-b", campaignId: "c1", email: "rb@example.com", createdAt: new Date("2026-10-01T10:00:00Z") },
        ],
        drafts: [
          { id: "d-c", campaignId: "c1", recipientId: "r-c", promptVersion: fingerprint, status: "READY", subject: "S-C", body: "B-C" },
          { id: "d-a", campaignId: "c1", recipientId: "r-a", promptVersion: fingerprint, status: "READY", subject: "S-A", body: "B-A" },
          { id: "d-b", campaignId: "c1", recipientId: "r-b", promptVersion: fingerprint, status: "READY", subject: "S-B", body: "B-B" },
        ],
      });

      const sendJobs: any[] = [];
      const addSendJob = vi.fn(async (job, opts) => {
        sendJobs.push({ job, opts });
      });

      const moved = await scheduleCampaign("c1", "GENERATING", {
        db,
        clock,
        addSendJob,
        ai: { campaignDelayBetweenEmailsMs: 2500 } as any,
      });
      expect(moved).toBe(true);

      expect(sendJobs).toHaveLength(3);
      expect(sendJobs[0].job.recipientEmail).toBe("ra@example.com");
      expect(sendJobs[0].opts.delay).toBe(baseDelay);

      expect(sendJobs[1].job.recipientEmail).toBe("rb@example.com");
      expect(sendJobs[1].opts.delay).toBe(baseDelay + 2500);

      expect(sendJobs[2].job.recipientEmail).toBe("rc@example.com");
      expect(sendJobs[2].opts.delay).toBe(baseDelay + 5000);
    });

    it("two concurrent scheduleCampaign calls create each EmailJob once", async () => {
      const fingerprint = "fp1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            userId: "owner@example.com",
            status: "GENERATING",
            promptFingerprint: fingerprint,
            scheduledAt: new Date(),
          },
        ],
        recipients: [{ id: "r1", campaignId: "c1", email: "r1@example.com" }],
        drafts: [
          { id: "d1", campaignId: "c1", recipientId: "r1", promptVersion: fingerprint, status: "READY", subject: "S", body: "B" },
        ],
      });

      const addSendJob = vi.fn();
      const [r1, r2] = await Promise.all([
        scheduleCampaign("c1", "GENERATING", { db, addSendJob }),
        scheduleCampaign("c1", "GENERATING", { db, addSendJob }),
      ]);

      const successCount = [r1, r2].filter(Boolean).length;
      expect(successCount).toBe(1);
      expect(addSendJob).toHaveBeenCalledTimes(1);
      expect(db._state.emailJobs.size).toBe(1);
    });

    it("a failing enqueue leaves pending EmailJob rows and one reconcileSends run adds the jobs", async () => {
      const fingerprint = "fp1";
      const scheduledAt = new Date(Date.now() + 60000);
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            userId: "owner@example.com",
            status: "GENERATING",
            promptFingerprint: fingerprint,
            scheduledAt,
          },
        ],
        recipients: [{ id: "r1", campaignId: "c1", email: "r1@example.com" }],
        drafts: [
          { id: "d1", campaignId: "c1", recipientId: "r1", promptVersion: fingerprint, status: "READY", subject: "S", body: "B" },
        ],
      });

      // Enqueue fails during scheduleCampaign
      const failingAddSendJob = vi.fn().mockRejectedValue(new Error("Redis connection refused"));
      const logger = { error: vi.fn(), info: vi.fn() };

      const moved = await scheduleCampaign("c1", "GENERATING", {
        db,
        addSendJob: failingAddSendJob,
        logger,
      });

      expect(moved).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("send enqueue failed: Error"));

      // The EmailJob row exists and is pending
      const draft = db._state.drafts.get("d1");
      expect(draft.status).toBe("QUEUED");
      const emailJob = db._state.emailJobs.get(draft.emailJobId);
      expect(emailJob).toBeDefined();
      expect(emailJob.status).toBe("pending");

      // Now run reconcileSends
      const enqueuedReconciledJobs: any[] = [];
      const reconcileAddJob = vi.fn(async (name, data, opts) => {
        enqueuedReconciledJobs.push({ name, data, opts });
      });

      const outcome = await reconcileSends("c1", {
        db,
        getJob: vi.fn().mockResolvedValue(null), // Job missing in queue
        addJob: reconcileAddJob,
      });

      expect(outcome.reconciledCount).toBe(1);
      expect(outcome.jobIds).toContain(emailJob.id);
      expect(enqueuedReconciledJobs).toHaveLength(1);
      expect(enqueuedReconciledJobs[0].data.jobId).toBe(emailJob.id);
    });

    it("draft switched to plain between read and update is not overwritten, and a later reconcileSends creates its EmailJob with plain content", async () => {
      const fingerprint = "fp1";
      const scheduledAt = new Date("2026-12-01T12:00:00Z");

      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            userId: "owner@example.com",
            status: "GENERATING",
            promptFingerprint: fingerprint,
            scheduledAt,
          },
        ],
        recipients: [{ id: "r1", campaignId: "c1", email: "r1@example.com" }],
        drafts: [
          {
            id: "d1",
            campaignId: "c1",
            recipientId: "r1",
            promptVersion: fingerprint,
            status: "READY",
            subject: "AI Subject",
            body: "AI Body",
          },
        ],
      });

      const origFindMany = db.generatedDraft.findMany;
      db.generatedDraft.findMany = vi.fn(async (args: any) => {
        const result = await origFindMany(args);
        // Between read and update, the draft is switched to plain by the user
        const d1 = db._state.drafts.get("d1");
        if (d1 && d1.status === "READY") {
          d1.status = "FALLBACK";
          d1.subject = "Plain Subject";
          d1.body = "Plain Body";
          d1.fallbackReason = "USER_PLAIN";
        }
        return result;
      });

      const addSendJob = vi.fn();
      const logger = { info: vi.fn(), error: vi.fn() };

      const moved = await scheduleCampaign("c1", "GENERATING", {
        db,
        addSendJob,
        logger,
      });

      expect(moved).toBe(true);

      // Verify draft was NOT overwritten with old content during scheduleCampaign
      const d1AfterSchedule = db._state.drafts.get("d1");
      expect(d1AfterSchedule.status).toBe("FALLBACK");
      expect(d1AfterSchedule.subject).toBe("Plain Subject");
      expect(d1AfterSchedule.body).toBe("Plain Body");
      expect(d1AfterSchedule.emailJobId).toBeUndefined();

      // No send job was enqueued because the draft was skipped
      expect(addSendJob).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Skipped 1 drafts that no longer matched preconditions")
      );

      // Now run reconcileSends (the sweep should pick up d1 with status FALLBACK)
      const reconcileAddJob = vi.fn().mockResolvedValue(undefined);
      const sweepOutcome = await reconcileSends("c1", {
        db,
        addJob: reconcileAddJob,
      });

      expect(sweepOutcome.reconciledCount).toBe(1);
      const d1AfterReconcile = db._state.drafts.get("d1");
      expect(d1AfterReconcile.status).toBe("QUEUED");
      expect(d1AfterReconcile.emailJobId).toBeDefined();

      const createdEmailJob = db._state.emailJobs.get(d1AfterReconcile.emailJobId);
      expect(createdEmailJob).toBeDefined();
      expect(createdEmailJob.subject).toBe("Plain Subject");
      expect(createdEmailJob.body).toBe("Plain Body");
      expect(createdEmailJob.recipientEmail).toBe("r1@example.com");

      expect(reconcileAddJob).toHaveBeenCalledWith(
        "email-job",
        expect.objectContaining({
          jobId: createdEmailJob.id,
          subject: "Plain Subject",
          body: "Plain Body",
        }),
        expect.objectContaining({
          jobId: createdEmailJob.id,
        })
      );
    });

    it("a draft without a recipient throws an Error instead of creating an EmailJob with empty recipientEmail", async () => {
      const fingerprint = "fp1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            userId: "owner@example.com",
            status: "GENERATING",
            promptFingerprint: fingerprint,
            scheduledAt: new Date(),
          },
        ],
        recipients: [], // No recipients in DB
        drafts: [
          {
            id: "d1",
            campaignId: "c1",
            recipientId: "missing-recipient",
            promptVersion: fingerprint,
            status: "READY",
            subject: "S",
            body: "B",
          },
        ],
      });

      await expect(
        scheduleCampaign("c1", "GENERATING", { db })
      ).rejects.toThrow(/Draft d1 has no recipient/);

      expect(db._state.emailJobs.size).toBe(0);
    });

    it("a non-P2025 error propagates and the transaction fails", async () => {
      const fingerprint = "fp1";
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            userId: "owner@example.com",
            status: "GENERATING",
            promptFingerprint: fingerprint,
            scheduledAt: new Date(),
          },
        ],
        recipients: [{ id: "r1", campaignId: "c1", email: "r1@example.com" }],
        drafts: [
          { id: "d1", campaignId: "c1", recipientId: "r1", promptVersion: fingerprint, status: "READY", subject: "S", body: "B" },
        ],
      });

      // Cause a non-P2025 error (e.g. database network error or unique violation)
      const nonP2025Error = new Error("Database connection closed");
      (nonP2025Error as any).code = "P1001";
      db.generatedDraft.update = vi.fn().mockRejectedValue(nonP2025Error);

      await expect(
        scheduleCampaign("c1", "GENERATING", { db })
      ).rejects.toThrow("Database connection closed");

      // No email jobs created
      expect(db._state.emailJobs.size).toBe(0);
    });
  });

  describe("startPlainCampaign", () => {
    it("executes end to end from DRAFT with aiEnabled false", async () => {
      const scheduledAt = new Date("2026-12-01T12:00:00Z");
      const db = createFakeDb({
        campaigns: [
          {
            id: "c_plain",
            userId: "plain_owner@example.com",
            status: "DRAFT",
            aiEnabled: false,
            subjectTemplate: "Hi {{first_name}}",
            bodyTemplate: "Welcome to {{company}}!\n\n{{unsubscribe_link}}",
            templateHash: "plain_hash",
            linkUrl: "https://example.com",
            unsubscribeUrl: "https://example.com/unsub",
            scheduledAt,
          },
        ],
        recipients: [
          {
            id: "r1",
            campaignId: "c_plain",
            email: "alice@example.com",
            firstName: "Alice",
            company: "Acme",
          },
          {
            id: "r2",
            campaignId: "c_plain",
            email: "bob@example.com",
            firstName: "Bob",
            company: "Beta",
          },
        ],
      });

      const sendJobs: any[] = [];
      const addSendJob = vi.fn(async (job, opts) => {
        sendJobs.push({ job, opts });
      });

      const result = await startPlainCampaign("c_plain", { db, addSendJob });
      expect(result.ok).toBe(true);
      expect(result.createdJobsCount).toBe(2);

      const campaign = db._state.campaigns.get("c_plain");
      expect(campaign.status).toBe("SCHEDULED");
      expect(campaign.promptFingerprint).toBe("none");

      // Verify drafts
      const allDrafts = Array.from(db._state.drafts.values()) as any[];
      expect(allDrafts).toHaveLength(2);
      for (const d of allDrafts) {
        expect(d.status).toBe("QUEUED");
        expect(d.fallbackReason).toBe("AI_DISABLED");
        expect(d.promptVersion).toBe("none");
        expect(d.emailJobId).toBeDefined();
      }

      // Verify rendered subject and body on the drafts
      const draftAlice = allDrafts.find((d) => d.recipientId === "r1");
      expect(draftAlice.subject).toBe("Hi Alice");
      expect(draftAlice.body).toContain("Welcome to Acme!");
      expect(draftAlice.body).toContain('<a href="https://example.com/unsub">https://example.com/unsub</a>');

      // Verify EmailJobs
      expect(db._state.emailJobs.size).toBe(2);
      expect(sendJobs).toHaveLength(2);
    });

    it("throws EmptyCampaignError when campaign has zero recipients", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c_empty",
            userId: "owner@example.com",
            status: "DRAFT",
            aiEnabled: false,
            scheduledAt: new Date(),
          },
        ],
        recipients: [],
      });

      await expect(startPlainCampaign("c_empty", { db })).rejects.toThrow(EmptyCampaignError);
      expect(db._state.campaigns.get("c_empty").status).toBe("DRAFT");
    });

    it("rejects when aiEnabled is true", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c_ai",
            status: "DRAFT",
            aiEnabled: true,
            scheduledAt: new Date(),
          },
        ],
        recipients: [{ id: "r1", campaignId: "c_ai" }],
      });

      await expect(startPlainCampaign("c_ai", { db })).rejects.toThrowError(/AI personalization enabled/);
    });

    it("rejects when campaign is not in DRAFT", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c_paused",
            status: "PAUSED",
            aiEnabled: false,
            scheduledAt: new Date(),
          },
        ],
        recipients: [{ id: "r1", campaignId: "c_paused" }],
      });

      await expect(startPlainCampaign("c_paused", { db })).rejects.toThrow(IllegalTransitionError);
    });
  });
});
