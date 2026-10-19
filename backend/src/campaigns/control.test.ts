import { describe, expect, it, vi } from "vitest";
import {
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  CancelNotSupportedYetError,
  IdentityMismatchError,
  type ControlDeps,
} from "./control";
import { IllegalTransitionError } from "./stateMachine";
import type { CampaignStatus } from "../generated/prisma/client";

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
    },
    generatedDraft: {
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
      createMany: vi.fn(async ({ data }: { data: any[] }) => {
        for (const item of data) {
          drafts.set(item.id, { ...item });
        }
        return { count: data.length };
      }),
      findMany: vi.fn(async ({ where }: { where?: any }) => {
        let list = Array.from(drafts.values());
        if (where?.campaignId) {
          list = list.filter((d) => d.campaignId === where.campaignId);
        }
        return list.map((d) => ({ ...d }));
      }),
    },
    $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(client)),
  };

  return { client, campaigns, drafts, recipients };
}

describe("control.ts - pauseCampaign", () => {
  const allowedStatuses: CampaignStatus[] = [
    "SAMPLING",
    "SAMPLE_REVIEW",
    "GENERATING",
    "EXCEPTION_REVIEW",
  ];

  for (const status of allowedStatuses) {
    it(`pauses campaign from ${status} and sets errorMessage`, async () => {
      const { client, campaigns } = createFakeDb({
        campaigns: [
          {
            id: "camp-1",
            status,
            errorMessage: null,
          },
        ],
      });

      const res = await pauseCampaign("camp-1", { db: client as any });
      expect(res.ok).toBe(true);

      const updated = campaigns.get("camp-1");
      expect(updated.status).toBe("PAUSED");
      expect(updated.errorMessage).toBe("Paused by the user.");
    });
  }

  const disallowedStatuses: CampaignStatus[] = [
    "DRAFT",
    "SCHEDULED",
    "SENDING",
    "COMPLETED",
    "CANCELLED",
    "PAUSED",
  ];

  for (const status of disallowedStatuses) {
    it(`rejects pausing campaign from ${status}`, async () => {
      const { client, campaigns } = createFakeDb({
        campaigns: [
          {
            id: "camp-1",
            status,
            errorMessage: null,
          },
        ],
      });

      await expect(pauseCampaign("camp-1", { db: client as any })).rejects.toThrow(
        IllegalTransitionError
      );
      expect(campaigns.get("camp-1").status).toBe(status);
    });
  }
});

describe("control.ts - resumeCampaign", () => {
  const mockIdentity = {
    promptTemplateVersion: "personalize.v2",
    llmModel: "mock-model",
  };

  it("throws IllegalTransitionError when campaign is not PAUSED", async () => {
    const { client } = createFakeDb({
      campaigns: [
        {
          id: "camp-1",
          status: "SAMPLING",
          promptTemplateVersion: "personalize.v2",
          llmModel: "mock-model",
          approvedPromptVersion: null,
        },
      ],
    });

    await expect(
      resumeCampaign("camp-1", { db: client as any, identity: mockIdentity })
    ).rejects.toThrow(IllegalTransitionError);
  });

  describe("when identity matches", () => {
    it("resumes to SAMPLING when approvedPromptVersion is null, clears errorMessage, and reconciles", async () => {
      const reconcile = vi.fn(async () => ({ reconciledCount: 0, draftIds: [] }));
      const { client, campaigns } = createFakeDb({
        campaigns: [
          {
            id: "camp-1",
            status: "PAUSED",
            errorMessage: "Paused by the user.",
            promptTemplateVersion: "personalize.v2",
            llmModel: "mock-model",
            approvedPromptVersion: null,
          },
        ],
      });

      const res = await resumeCampaign("camp-1", {
        db: client as any,
        identity: mockIdentity,
        reconcile,
      });

      expect(res.ok).toBe(true);
      expect(res.status).toBe("SAMPLING");

      const updated = campaigns.get("camp-1");
      expect(updated.status).toBe("SAMPLING");
      expect(updated.errorMessage).toBeNull();
      expect(reconcile).toHaveBeenCalledWith("camp-1");
    });

    it("resumes to GENERATING when approvedPromptVersion is set, clears errorMessage, and reconciles", async () => {
      const reconcile = vi.fn(async () => ({ reconciledCount: 0, draftIds: [] }));
      const { client, campaigns } = createFakeDb({
        campaigns: [
          {
            id: "camp-1",
            status: "PAUSED",
            errorMessage: "Paused by the user.",
            promptTemplateVersion: "personalize.v2",
            llmModel: "mock-model",
            approvedPromptVersion: "fingerprint-123",
          },
        ],
      });

      const res = await resumeCampaign("camp-1", {
        db: client as any,
        identity: mockIdentity,
        reconcile,
      });

      expect(res.ok).toBe(true);
      expect(res.status).toBe("GENERATING");

      const updated = campaigns.get("camp-1");
      expect(updated.status).toBe("GENERATING");
      expect(updated.errorMessage).toBeNull();
      expect(reconcile).toHaveBeenCalledWith("camp-1");
    });

    it("survives reconcile throwing after commit: logs error class and returns normally", async () => {
      const reconcile = vi.fn(async () => {
        throw new TypeError("Transient redis error");
      });
      const logger = { error: vi.fn(), info: vi.fn() };
      const { client, campaigns } = createFakeDb({
        campaigns: [
          {
            id: "camp-1",
            status: "PAUSED",
            errorMessage: "Paused by the user.",
            promptTemplateVersion: "personalize.v2",
            llmModel: "mock-model",
            approvedPromptVersion: "fingerprint-123",
          },
        ],
      });

      const res = await resumeCampaign("camp-1", {
        db: client as any,
        identity: mockIdentity,
        reconcile,
        logger,
      });

      expect(res.ok).toBe(true);
      expect(res.status).toBe("GENERATING");

      const updated = campaigns.get("camp-1");
      expect(updated.status).toBe("GENERATING");
      expect(updated.errorMessage).toBeNull();
      expect(reconcile).toHaveBeenCalledWith("camp-1");
      expect(logger.error).toHaveBeenCalledWith("[Control] reconcile failed: TypeError");
    });
  });

  describe("when identity differs", () => {
    const liveIdentity = {
      promptTemplateVersion: "personalize.v2",
      llmModel: "new-live-model",
    };

    it("before approval: deletes drafts, re-freezes identity, creates sample drafts, resumes to SAMPLING, and enqueues", async () => {
      const enqueue = vi.fn(async (_jobs: any[]) => {});
      const { client, campaigns, drafts } = createFakeDb({
        campaigns: [
          {
            id: "camp-1",
            status: "PAUSED",
            errorMessage: "Paused by the user.",
            promptTemplateVersion: "personalize.v2",
            llmModel: "old-model",
            promptFingerprint: "old-fp",
            approvedPromptVersion: null,
            templateHash: "th-1",
            aiInstruction: "be friendly",
          },
        ],
        recipients: [
          { id: "rec-1", campaignId: "camp-1", email: "a@test.com", company: "Acme Corp" },
          { id: "rec-2", campaignId: "camp-1", email: "b@test.com", company: "Beta Inc" },
        ],
        drafts: [
          { id: "old-draft-1", campaignId: "camp-1", promptVersion: "old-fp" },
        ],
      });

      const res = await resumeCampaign("camp-1", {
        db: client as any,
        identity: liveIdentity,
        enqueue,
        sampleSize: 2,
      });

      expect(res.ok).toBe(true);
      expect(res.status).toBe("SAMPLING");

      const updated = campaigns.get("camp-1");
      expect(updated.status).toBe("SAMPLING");
      expect(updated.errorMessage).toBeNull();
      expect(updated.llmModel).toBe("new-live-model");
      expect(updated.promptFingerprint).not.toBe("old-fp");

      // Old draft deleted, new sample drafts created
      expect(drafts.has("old-draft-1")).toBe(false);
      expect(drafts.size).toBe(2);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue.mock.calls[0][0]).toHaveLength(2);
    });

    it("after approval: throws IdentityMismatchError and changes nothing", async () => {
      const enqueue = vi.fn(async () => {});
      const reconcile = vi.fn(async () => ({ reconciledCount: 0, draftIds: [] }));
      const { client, campaigns, drafts } = createFakeDb({
        campaigns: [
          {
            id: "camp-1",
            status: "PAUSED",
            errorMessage: "Paused by the user.",
            promptTemplateVersion: "personalize.v2",
            llmModel: "old-model",
            promptFingerprint: "approved-fp",
            approvedPromptVersion: "approved-fp",
            templateHash: "th-1",
            aiInstruction: "be friendly",
          },
        ],
        drafts: [
          { id: "draft-1", campaignId: "camp-1", promptVersion: "approved-fp" },
        ],
      });

      await expect(
        resumeCampaign("camp-1", {
          db: client as any,
          identity: liveIdentity,
          enqueue,
          reconcile,
        })
      ).rejects.toThrow(IdentityMismatchError);

      const campaign = campaigns.get("camp-1");
      expect(campaign.status).toBe("PAUSED");
      expect(campaign.llmModel).toBe("old-model");
      expect(campaign.errorMessage).toBe("Paused by the user.");
      expect(drafts.has("draft-1")).toBe(true);
      expect(enqueue).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    });
  });
});

describe("control.ts - cancelCampaign", () => {
  const allowedStatuses: CampaignStatus[] = [
    "DRAFT",
    "SAMPLING",
    "SAMPLE_REVIEW",
    "GENERATING",
    "EXCEPTION_REVIEW",
    "PAUSED",
  ];

  for (const status of allowedStatuses) {
    it(`cancels campaign from ${status}`, async () => {
      const { client, campaigns } = createFakeDb({
        campaigns: [
          {
            id: "camp-1",
            status,
          },
        ],
      });

      const res = await cancelCampaign("camp-1", { db: client as any });
      expect(res.ok).toBe(true);
      expect(campaigns.get("camp-1").status).toBe("CANCELLED");
    });
  }

  it("throws CancelNotSupportedYetError when campaign is SCHEDULED", async () => {
    const { client, campaigns } = createFakeDb({
      campaigns: [{ id: "camp-1", status: "SCHEDULED" }],
    });

    const err = await cancelCampaign("camp-1", { db: client as any }).catch((e) => e);
    expect(err).toBeInstanceOf(CancelNotSupportedYetError);
    expect((err as CancelNotSupportedYetError).code).toBe("CANCEL_NOT_SUPPORTED_YET");
    expect(campaigns.get("camp-1").status).toBe("SCHEDULED");
  });

  it("throws CancelNotSupportedYetError when campaign is SENDING", async () => {
    const { client, campaigns } = createFakeDb({
      campaigns: [{ id: "camp-1", status: "SENDING" }],
    });

    const err = await cancelCampaign("camp-1", { db: client as any }).catch((e) => e);
    expect(err).toBeInstanceOf(CancelNotSupportedYetError);
    expect((err as CancelNotSupportedYetError).code).toBe("CANCEL_NOT_SUPPORTED_YET");
    expect(campaigns.get("camp-1").status).toBe("SENDING");
  });

  it("throws IllegalTransitionError when campaign is already CANCELLED or COMPLETED", async () => {
    const { client: client1 } = createFakeDb({
      campaigns: [{ id: "camp-1", status: "CANCELLED" }],
    });
    await expect(cancelCampaign("camp-1", { db: client1 as any })).rejects.toThrow(
      IllegalTransitionError
    );

    const { client: client2 } = createFakeDb({
      campaigns: [{ id: "camp-2", status: "COMPLETED" }],
    });
    await expect(cancelCampaign("camp-2", { db: client2 as any })).rejects.toThrow(
      IllegalTransitionError
    );
  });
});
