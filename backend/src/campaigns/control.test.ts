import { describe, expect, it, vi } from "vitest";
import {
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  releaseUnsentJobs,
  finishCancellations,
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
      updateMany: vi.fn(async ({ where, data }: { where: any; data: any }) => {
        let count = 0;
        for (const d of drafts.values()) {
          const idMatches = where.id?.in
            ? where.id.in.includes(d.id)
            : where.id === undefined || where.id === d.id;
          if (!idMatches) continue;
          if (where.emailJobId === null && d.emailJobId !== null) continue;
          if (where.status && d.status !== where.status) continue;
          Object.assign(d, data);
          count++;
        }
        return { count };
      }),
    },
    emailJob: {
      findMany: vi.fn(async ({ where, take }: { where?: any; take?: number }) => {
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
          list = list.filter((j) => {
            const draft = Array.from(drafts.values()).find((d) => d.emailJobId === j.id);
            return draft && draft.campaignId === cId;
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
    },
    $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(client)),
  };

  return { client, campaigns, drafts, recipients, emailJobs };
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
    "SCHEDULED",
    "SENDING",
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

  it("cancels from SCHEDULED: deletes pending/rate_limited rows, keeps sent/failed rows, sets drafts to HELD, removes non-active queue jobs", async () => {
    const jobRemovals: string[] = [];
    const getJob = vi.fn(async (id: string) => {
      if (id === "job-active") {
        return {
          getState: async () => "active",
          remove: vi.fn(async () => {
            jobRemovals.push(id);
          }),
        };
      }
      return {
        getState: async () => "delayed",
        remove: vi.fn(async () => {
          jobRemovals.push(id);
        }),
      };
    });

    const { client, campaigns, drafts, emailJobs } = createFakeDb({
      campaigns: [{ id: "camp-1", status: "SCHEDULED" }],
      drafts: [
        { id: "d-pending", campaignId: "camp-1", status: "QUEUED", emailJobId: "job-pending" },
        { id: "d-ratelimited", campaignId: "camp-1", status: "QUEUED", emailJobId: "job-ratelimited" },
        { id: "d-active", campaignId: "camp-1", status: "QUEUED", emailJobId: "job-active" },
        { id: "d-sent", campaignId: "camp-1", status: "QUEUED", emailJobId: "job-sent" },
        { id: "d-failed", campaignId: "camp-1", status: "QUEUED", emailJobId: "job-failed" },
      ],
      emailJobs: [
        { id: "job-pending", status: "pending" },
        { id: "job-ratelimited", status: "rate_limited" },
        { id: "job-active", status: "pending" },
        { id: "job-sent", status: "sent" },
        { id: "job-failed", status: "failed" },
      ],
    });

    const res = await cancelCampaign("camp-1", { db: client as any, getJob });
    expect(res.ok).toBe(true);

    // (a) Campaign transitioned to CANCELLED
    expect(campaigns.get("camp-1").status).toBe("CANCELLED");

    // (b) Pending and rate_limited rows deleted
    expect(emailJobs.has("job-pending")).toBe(false);
    expect(emailJobs.has("job-ratelimited")).toBe(false);
    expect(emailJobs.has("job-active")).toBe(false); // pending in DB, active in queue

    // Sent and failed rows kept
    expect(emailJobs.has("job-sent")).toBe(true);
    expect(emailJobs.has("job-failed")).toBe(true);

    // Drafts for deleted jobs moved to HELD and emailJobId SetNull
    expect(drafts.get("d-pending").status).toBe("HELD");
    expect(drafts.get("d-pending").emailJobId).toBeNull();
    expect(drafts.get("d-ratelimited").status).toBe("HELD");
    expect(drafts.get("d-ratelimited").emailJobId).toBeNull();
    expect(drafts.get("d-active").status).toBe("HELD");
    expect(drafts.get("d-active").emailJobId).toBeNull();

    // Sent and failed drafts remain untouched
    expect(drafts.get("d-sent").status).toBe("QUEUED");
    expect(drafts.get("d-sent").emailJobId).toBe("job-sent");
    expect(drafts.get("d-failed").status).toBe("QUEUED");
    expect(drafts.get("d-failed").emailJobId).toBe("job-failed");

    // (c) Queue jobs removed unless active
    expect(jobRemovals).toContain("job-pending");
    expect(jobRemovals).toContain("job-ratelimited");
    expect(jobRemovals).not.toContain("job-active");
  });

  it("survives queue removal errors: logs error class and continues", async () => {
    const logger = { error: vi.fn(), info: vi.fn() };
    const getJob = vi.fn(async () => ({
      getState: async () => "waiting",
      remove: vi.fn(async () => {
        throw new TypeError("BullMQ connection error");
      }),
    }));

    const { client, campaigns } = createFakeDb({
      campaigns: [{ id: "camp-1", status: "SENDING" }],
      drafts: [
        { id: "d-1", campaignId: "camp-1", status: "QUEUED", emailJobId: "job-1" },
      ],
      emailJobs: [
        { id: "job-1", status: "pending" },
      ],
    });

    const res = await cancelCampaign("camp-1", { db: client as any, getJob, logger });
    expect(res.ok).toBe(true);
    expect(campaigns.get("camp-1").status).toBe("CANCELLED");
    expect(logger.error).toHaveBeenCalledWith("[Control] queue remove failed: TypeError");
  });

  it("an EmailJob flipped to 'sent' between the find and the delete survives, and its draft stays QUEUED", async () => {
    const queueRemovals: string[] = [];
    const getJob = vi.fn(async (id: string) => ({
      getState: async () => "delayed",
      remove: vi.fn(async () => {
        queueRemovals.push(id);
      }),
    }));

    const { client, campaigns, drafts, emailJobs } = createFakeDb({
      campaigns: [{ id: "camp-1", status: "SCHEDULED" }],
      drafts: [
        { id: "d-pending", campaignId: "camp-1", status: "QUEUED", emailJobId: "job-pending" },
        { id: "d-flipping", campaignId: "camp-1", status: "QUEUED", emailJobId: "job-flipping" },
      ],
      emailJobs: [
        { id: "job-pending", status: "pending" },
        { id: "job-flipping", status: "pending" },
      ],
    });

    // Simulate concurrent flip: when findMany is called, job-flipping is returned as pending;
    // but before deleteMany runs, job-flipping flips to "sent" in DB
    const origFindMany = client.emailJob.findMany;
    let findManyCalled = false;
    client.emailJob.findMany = vi.fn(async (args: any) => {
      const res = await origFindMany(args);
      if (!findManyCalled && args?.where?.generatedDraft?.campaignId) {
        findManyCalled = true;
        const job = emailJobs.get("job-flipping");
        if (job) job.status = "sent";
      }
      return res;
    });

    const res = await cancelCampaign("camp-1", { db: client as any, getJob });
    expect(res.ok).toBe(true);
    expect(campaigns.get("camp-1").status).toBe("CANCELLED");

    // job-flipping survived with status "sent"
    expect(emailJobs.has("job-flipping")).toBe(true);
    expect(emailJobs.get("job-flipping").status).toBe("sent");

    // draft for job-flipping stays QUEUED with emailJobId intact
    expect(drafts.get("d-flipping").status).toBe("QUEUED");
    expect(drafts.get("d-flipping").emailJobId).toBe("job-flipping");

    // job-pending was deleted and its draft became HELD
    expect(emailJobs.has("job-pending")).toBe(false);
    expect(drafts.get("d-pending").status).toBe("HELD");
    expect(drafts.get("d-pending").emailJobId).toBeNull();

    // queue remove was only called for the deleted job-pending, NOT job-flipping
    expect(queueRemovals).toEqual(["job-pending"]);
  });

  it("breaks out and logs count only when chunk deletes 0 rows and next findMany returns same ids", async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const { client, campaigns } = createFakeDb({
      campaigns: [{ id: "camp-1", status: "SCHEDULED" }],
      drafts: [
        { id: "d-1", campaignId: "camp-1", status: "QUEUED", emailJobId: "job-1" },
      ],
      emailJobs: [
        { id: "job-1", status: "pending" },
      ],
    });

    // deleteMany deletes 0 rows
    client.emailJob.deleteMany = vi.fn().mockResolvedValue({ count: 0 });

    const res = await cancelCampaign("camp-1", { db: client as any, logger });
    expect(res.ok).toBe(true);
    expect(campaigns.get("camp-1").status).toBe("CANCELLED");
    const log = logger.info.mock.calls.length > 0 ? logger.info : logger.error;
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/1/));
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

describe("control.ts - finishCancellations", () => {
  it("cleans up CANCELLED campaigns that still have pending email jobs", async () => {
    const queueRemovals: string[] = [];
    const getJob = vi.fn(async (id: string) => ({
      getState: async () => "waiting",
      remove: vi.fn(async () => {
        queueRemovals.push(id);
      }),
    }));

    const { client, drafts, emailJobs } = createFakeDb({
      campaigns: [
        { id: "c-active", status: "SCHEDULED" },
        { id: "c-cancelled", status: "CANCELLED" },
      ],
      drafts: [
        { id: "d-active", campaignId: "c-active", status: "QUEUED", emailJobId: "job-active" },
        { id: "d-cancelled", campaignId: "c-cancelled", status: "QUEUED", emailJobId: "job-cancelled" },
      ],
      emailJobs: [
        { id: "job-active", status: "pending" },
        { id: "job-cancelled", status: "pending" },
      ],
    });

    const res = await finishCancellations({ db: client as any, getJob });
    expect(res.processedCount).toBe(1);
    expect(res.campaignIds).toEqual(["c-cancelled"]);

    // c-cancelled pending job is deleted, draft is HELD, queue job removed
    expect(emailJobs.has("job-cancelled")).toBe(false);
    expect(drafts.get("d-cancelled").status).toBe("HELD");
    expect(drafts.get("d-cancelled").emailJobId).toBeNull();
    expect(queueRemovals).toEqual(["job-cancelled"]);

    // c-active pending job is untouched
    expect(emailJobs.has("job-active")).toBe(true);
    expect(drafts.get("d-active").status).toBe("QUEUED");
  });
});
