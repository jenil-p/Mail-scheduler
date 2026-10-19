import { describe, expect, it, vi } from "vitest";
import {
  approveSamples,
  InvalidInstructionError,
  refreshCampaign,
  regenerateSamples,
  scheduleCampaign,
  startSampling,
  type FlowDeps,
  type FlowEnqueueItem,
} from "./flow";
import { IllegalTransitionError } from "./stateMachine";
import { createDailyUsageGetter } from "./budget";
import type { CampaignStatus } from "../generated/prisma/client";

// In-memory Prisma fake for unit testing flow transactions and preconditions
function createFakeDb(initialState: {
  campaigns?: any[];
  recipients?: any[];
  drafts?: any[];
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
      findMany: vi.fn(async ({ where }: { where: any }) => {
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
        return list.map((d) => ({ ...d }));
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
    $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => {
      return cb(client);
    }),
    _state: { campaigns, recipients, drafts },
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

    it("never touches campaigns in PAUSED, CANCELLED, SCHEDULED, SENDING or COMPLETED", async () => {
      for (const status of ["PAUSED", "CANCELLED", "SCHEDULED", "SENDING", "COMPLETED"] as CampaignStatus[]) {
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
});
