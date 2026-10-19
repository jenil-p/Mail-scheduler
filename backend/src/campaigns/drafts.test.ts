import { describe, expect, it, vi } from "vitest";
import {
  resolveDraft,
  bulkResolve,
  listDrafts,
  getCampaignSummary,
  CampaignNotUnderReviewError,
  StaleDraftError,
  DraftNotFoundError,
  CampaignNotFoundError,
  HARD_BLOCK_CODES,
  HardBlockedError,
} from "./drafts";
import type { CampaignStatus, DraftStatus } from "../generated/prisma/client";

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
      count: vi.fn(async ({ where }: { where?: { campaignId: string } }) => {
        const list = Array.from(recipients.values());
        if (where?.campaignId) {
          return list.filter((r) => r.campaignId === where.campaignId).length;
        }
        return list.length;
      }),
    },
    generatedDraft: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const d = drafts.get(where.id);
        if (!d) return null;
        const c = campaigns.get(d.campaignId);
        const r = recipients.get(d.recipientId);
        return {
          ...d,
          campaign: c ? { ...c } : null,
          recipient: r ? { ...r } : null,
        };
      }),
      findMany: vi.fn(async (args: any = {}) => {
        let list = Array.from(drafts.values());
        const where = args.where ?? {};
        if (where.campaignId) {
          list = list.filter((d) => d.campaignId === where.campaignId);
        }
        if (where.promptVersion) {
          list = list.filter((d) => d.promptVersion === where.promptVersion);
        }
        if (where.status) {
          if (typeof where.status === "string") {
            list = list.filter((d) => d.status === where.status);
          } else if (where.status.in) {
            list = list.filter((d) => where.status.in.includes(d.status));
          }
        }
        if (where.isSample !== undefined) {
          list = list.filter((d) => d.isSample === where.isSample);
        }
        list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

        if (args.cursor?.id) {
          const idx = list.findIndex((d) => d.id === args.cursor.id);
          if (idx !== -1) {
            list = list.slice(idx + (args.skip ? args.skip : 0));
          }
        }
        if (args.take !== undefined) {
          list = list.slice(0, args.take);
        }
        return list.map((d) => {
          const r = recipients.get(d.recipientId);
          return {
            ...d,
            recipient: r ? { email: r.email, firstName: r.firstName } : null,
          };
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
        if (where.status) {
          if (typeof where.status === "string") {
            list = list.filter((d) => d.status === where.status);
          } else if (where.status.in) {
            list = list.filter((d) => where.status.in.includes(d.status));
          }
        }
        return list.length;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: any; data: any }) => {
        let count = 0;
        for (const d of drafts.values()) {
          const idMatches = where.id?.in
            ? where.id.in.includes(d.id)
            : where.id === undefined || where.id === d.id;
          let statusMatches = true;
          if (where.status) {
            if (typeof where.status === "string") {
              statusMatches = d.status === where.status;
            } else if (where.status.in) {
              statusMatches = where.status.in.includes(d.status);
            }
          }
          if (idMatches && statusMatches) {
            Object.assign(d, data);
            count++;
          }
        }
        return { count };
      }),
    },
    $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(client)),
  };

  return { client, campaigns, drafts, recipients };
}

describe("drafts.ts - resolveDraft", () => {
  const baseCampaign = {
    id: "camp-1",
    status: "EXCEPTION_REVIEW" as CampaignStatus,
    promptFingerprint: "fp-v1",
    subjectTemplate: "Hello {{first_name}}",
    bodyTemplate: "{{ai_intro}}\nContent here.\n{{unsubscribe_link}}",
    linkUrl: "https://example.com",
    unsubscribeUrl: "https://example.com/unsub",
  };

  const baseRecipient = {
    id: "rec-1",
    campaignId: "camp-1",
    email: "test@example.com",
    firstName: "Alice",
    company: "Acme Corp",
  };

  const baseDraft = {
    id: "draft-1",
    campaignId: "camp-1",
    recipientId: "rec-1",
    status: "FLAGGED" as DraftStatus,
    promptVersion: "fp-v1",
    subject: "Hello Alice",
    body: "Intro: Bad intro\nContent here.",
    aiIntro: "Bad intro",
    flagReasons: [{ code: "BANNED_PHRASE", detail: "Contains banned phrase" }],
  };

  it("approves FLAGGED draft: status APPROVED, keeps flagReasons, resolvedBy USER, calls refreshCampaign", async () => {
    const refreshFn = vi.fn(async () => ({ refreshed: false }));
    const { client, drafts } = createFakeDb({
      campaigns: [baseCampaign],
      recipients: [baseRecipient],
      drafts: [baseDraft],
    });

    const res = await resolveDraft("draft-1", { type: "approve" }, {
      db: client as any,
      refreshCampaign: refreshFn,
    });

    expect(res.applied).toBe(true);
    expect(res.status).toBe("APPROVED");
    expect(res.flagReasons).toEqual([{ code: "BANNED_PHRASE", detail: "Contains banned phrase" }]);

    const updated = drafts.get("draft-1");
    expect(updated.status).toBe("APPROVED");
    expect(updated.resolvedBy).toBe("USER");
    expect(updated.flagReasons).toEqual([{ code: "BANNED_PHRASE", detail: "Contains banned phrase" }]);
    expect(refreshFn).toHaveBeenCalledWith("camp-1", expect.anything());
  });

  it("use_plain resolves to FALLBACK, clears aiIntro and flagReasons, re-renders subject and body", async () => {
    const refreshFn = vi.fn(async () => ({ refreshed: false }));
    const { client, drafts } = createFakeDb({
      campaigns: [baseCampaign],
      recipients: [baseRecipient],
      drafts: [baseDraft],
    });

    const res = await resolveDraft("draft-1", { type: "use_plain" }, {
      db: client as any,
      refreshCampaign: refreshFn,
    });

    expect(res.applied).toBe(true);
    expect(res.status).toBe("FALLBACK");
    expect(res.flagReasons).toEqual([]);

    const updated = drafts.get("draft-1");
    expect(updated.status).toBe("FALLBACK");
    expect(updated.aiIntro).toBeNull();
    expect(updated.fallbackReason).toBe("USER_PLAIN");
    expect(updated.resolvedBy).toBe("USER");
    expect(updated.body).toContain("Content here.");
    expect(updated.body).toContain("https://example.com/unsub");
    expect(refreshFn).toHaveBeenCalledWith("camp-1", expect.anything());
  });

  it("edit-clean: validates new intro through guardrails, moves to APPROVED", async () => {
    const refreshFn = vi.fn(async () => ({ refreshed: false }));
    const { client, drafts } = createFakeDb({
      campaigns: [baseCampaign],
      recipients: [baseRecipient],
      drafts: [baseDraft],
    });

    const res = await resolveDraft("draft-1", {
      type: "edit",
      aiIntro: "Great to connect with the team at Acme Corp.",
    }, {
      db: client as any,
      refreshCampaign: refreshFn,
    });

    expect(res.applied).toBe(true);
    expect(res.status).toBe("APPROVED");
    expect(res.flagReasons).toEqual([]);

    const updated = drafts.get("draft-1");
    expect(updated.status).toBe("APPROVED");
    expect(updated.aiIntro).toBe("Great to connect with the team at Acme Corp.");
    expect(updated.resolvedBy).toBe("USER");
    expect(refreshFn).toHaveBeenCalledWith("camp-1", expect.anything());
  });

  it("edit-still-bad: new intro fails guardrails, stays FLAGGED with new flagReasons", async () => {
    const refreshFn = vi.fn(async () => ({ refreshed: false }));
    const { client, drafts } = createFakeDb({
      campaigns: [baseCampaign],
      recipients: [baseRecipient],
      drafts: [baseDraft],
    });

    // Intro with a banned phrase ("i noticed") and greeting ("Hello Alice")
    const res = await resolveDraft("draft-1", {
      type: "edit",
      aiIntro: "Hello Alice, I noticed your post online.",
    }, {
      db: client as any,
      refreshCampaign: refreshFn,
    });

    expect(res.applied).toBe(true);
    expect(res.status).toBe("FLAGGED");
    expect(res.flagReasons?.length).toBeGreaterThan(0);

    const updated = drafts.get("draft-1");
    expect(updated.status).toBe("FLAGGED");
    expect(updated.aiIntro).toBe("Hello Alice, I noticed your post online.");
    expect(updated.resolvedBy).toBe("USER");
    expect(refreshFn).toHaveBeenCalledWith("camp-1", expect.anything());
  });

  it("throws CampaignNotUnderReviewError when campaign is not in EXCEPTION_REVIEW", async () => {
    const { client } = createFakeDb({
      campaigns: [{ ...baseCampaign, status: "GENERATING" }],
      recipients: [baseRecipient],
      drafts: [baseDraft],
    });

    await expect(
      resolveDraft("draft-1", { type: "approve" }, { db: client as any })
    ).rejects.toThrow(CampaignNotUnderReviewError);
  });

  it("throws StaleDraftError when draft promptVersion does not match current campaign promptFingerprint", async () => {
    const { client } = createFakeDb({
      campaigns: [{ ...baseCampaign, promptFingerprint: "new-fp-v2" }],
      recipients: [baseRecipient],
      drafts: [{ ...baseDraft, promptVersion: "old-fp-v1" }],
    });

    await expect(
      resolveDraft("draft-1", { type: "approve" }, { db: client as any })
    ).rejects.toThrow(StaleDraftError);
  });

  it("returns applied false on wrong draft status (e.g. approving a PENDING draft)", async () => {
    const refreshFn = vi.fn(async () => ({ refreshed: false }));
    const { client } = createFakeDb({
      campaigns: [baseCampaign],
      recipients: [baseRecipient],
      drafts: [{ ...baseDraft, status: "PENDING" }],
    });

    const res = await resolveDraft("draft-1", { type: "approve" }, {
      db: client as any,
      refreshCampaign: refreshFn,
    });

    expect(res.applied).toBe(false);
    expect(res.status).toBe("PENDING");
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it("returns applied false on double apply", async () => {
    const refreshFn = vi.fn(async () => ({ refreshed: false }));
    const { client } = createFakeDb({
      campaigns: [baseCampaign],
      recipients: [baseRecipient],
      drafts: [baseDraft],
    });

    const first = await resolveDraft("draft-1", { type: "approve" }, {
      db: client as any,
      refreshCampaign: refreshFn,
    });
    expect(first.applied).toBe(true);

    const second = await resolveDraft("draft-1", { type: "approve" }, {
      db: client as any,
      refreshCampaign: refreshFn,
    });
    expect(second.applied).toBe(false);
  });

  it("throws HardBlockedError when approving a draft with hard-block codes and changes nothing", async () => {
    for (const code of HARD_BLOCK_CODES) {
      const blockedDraft = {
        ...baseDraft,
        id: `draft-blocked-${code}`,
        status: "FLAGGED" as DraftStatus,
        flagReasons: [{ code, message: `Failed ${code}` }],
      };

      const { client, drafts: draftMap } = createFakeDb({
        campaigns: [baseCampaign],
        recipients: [baseRecipient],
        drafts: [blockedDraft],
      });

      let thrownErr: any;
      try {
        await resolveDraft(blockedDraft.id, { type: "approve" }, { db: client as any });
      } catch (err) {
        thrownErr = err;
      }

      expect(thrownErr).toBeInstanceOf(HardBlockedError);
      expect(thrownErr.code).toBe("HARD_BLOCKED");
      expect(thrownErr.message).toContain(code);
      expect(draftMap.get(blockedDraft.id).status).toBe("FLAGGED");
    }
  });

  it("allows use_plain and edit for drafts with hard-block codes", async () => {
    const blockedDraft = {
      ...baseDraft,
      id: "draft-hard-blocked",
      status: "FLAGGED" as DraftStatus,
      flagReasons: [{ code: "FORBIDDEN_CONTENT", message: "Forbidden content detected" }],
    };

    // 1. use_plain resolves to FALLBACK
    const { client: client1, drafts: draftMap1 } = createFakeDb({
      campaigns: [baseCampaign],
      recipients: [baseRecipient],
      drafts: [blockedDraft],
    });

    const plainRes = await resolveDraft("draft-hard-blocked", { type: "use_plain" }, { db: client1 as any });
    expect(plainRes.applied).toBe(true);
    expect(plainRes.status).toBe("FALLBACK");
    expect(draftMap1.get("draft-hard-blocked").status).toBe("FALLBACK");

    // 2. edit with valid intro resolves to APPROVED
    const { client: client2, drafts: draftMap2 } = createFakeDb({
      campaigns: [baseCampaign],
      recipients: [baseRecipient],
      drafts: [blockedDraft],
    });

    const editRes = await resolveDraft(
      "draft-hard-blocked",
      { type: "edit", aiIntro: "Clean valid intro about Acme" },
      { db: client2 as any }
    );
    expect(editRes.applied).toBe(true);
    expect(editRes.status).toBe("APPROVED");
    expect(draftMap2.get("draft-hard-blocked").status).toBe("APPROVED");
  });
});

describe("drafts.ts - bulkResolve", () => {
  const baseCampaign = {
    id: "camp-1",
    status: "EXCEPTION_REVIEW" as CampaignStatus,
    promptFingerprint: "fp-v1",
    subjectTemplate: "Demo for {{first_name}}",
    bodyTemplate: "Intro: {{ai_intro}}\nBody.",
    linkUrl: "https://example.com",
    unsubscribeUrl: "https://example.com/unsub",
  };

  const recipients = [
    { id: "rec-1", campaignId: "camp-1", email: "a@test.com", firstName: "Alice" },
    { id: "rec-2", campaignId: "camp-1", email: "b@test.com", firstName: "Bob" },
    { id: "rec-3", campaignId: "camp-1", email: "c@test.com", firstName: "Carol" },
  ];

  const drafts = [
    {
      id: "draft-1",
      campaignId: "camp-1",
      recipientId: "rec-1",
      status: "FLAGGED" as DraftStatus,
      promptVersion: "fp-v1",
      flagReasons: [{ code: "BANNED_PHRASE", detail: "demo" }],
      subject: "Sub 1",
      body: "Body 1",
    },
    {
      id: "draft-2",
      campaignId: "camp-1",
      recipientId: "rec-2",
      status: "FLAGGED" as DraftStatus,
      promptVersion: "fp-v1",
      flagReasons: [{ code: "TOO_LONG", detail: "too long" }],
      subject: "Sub 2",
      body: "Body 2",
    },
    {
      id: "draft-3",
      campaignId: "camp-1",
      recipientId: "rec-3",
      status: "READY" as DraftStatus,
      promptVersion: "fp-v1",
      flagReasons: null,
      subject: "Sub 3",
      body: "Body 3",
    },
  ];

  it("approves all FLAGGED drafts without codes filter and calls refreshCampaign once", async () => {
    const refreshFn = vi.fn(async () => ({ refreshed: false }));
    const { client, drafts: draftMap } = createFakeDb({
      campaigns: [baseCampaign],
      recipients,
      drafts,
    });

    const res = await bulkResolve("camp-1", { type: "approve" }, {
      db: client as any,
      refreshCampaign: refreshFn,
    });

    expect(res).toEqual({ changed: 2, skippedHardBlocked: 0 });
    expect(draftMap.get("draft-1").status).toBe("APPROVED");
    expect(draftMap.get("draft-2").status).toBe("APPROVED");
    expect(draftMap.get("draft-3").status).toBe("READY");
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("approves only drafts matching codes filter", async () => {
    const refreshFn = vi.fn(async () => ({ refreshed: false }));
    const { client, drafts: draftMap } = createFakeDb({
      campaigns: [baseCampaign],
      recipients,
      drafts,
    });

    const res = await bulkResolve("camp-1", {
      type: "approve",
      codes: ["BANNED_PHRASE"],
    }, {
      db: client as any,
      refreshCampaign: refreshFn,
    });

    expect(res).toEqual({ changed: 1, skippedHardBlocked: 0 });
    expect(draftMap.get("draft-1").status).toBe("APPROVED");
    expect(draftMap.get("draft-2").status).toBe("FLAGGED");
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("bulk resolves with use_plain and re-renders plain templates", async () => {
    const refreshFn = vi.fn(async () => ({ refreshed: false }));
    const { client, drafts: draftMap } = createFakeDb({
      campaigns: [baseCampaign],
      recipients,
      drafts,
    });

    const res = await bulkResolve("camp-1", { type: "use_plain" }, {
      db: client as any,
      refreshCampaign: refreshFn,
    });

    expect(res).toEqual({ changed: 2, skippedHardBlocked: 0 });
    expect(draftMap.get("draft-1").status).toBe("FALLBACK");
    expect(draftMap.get("draft-1").fallbackReason).toBe("USER_PLAIN");
    expect(draftMap.get("draft-2").status).toBe("FALLBACK");
    expect(draftMap.get("draft-2").fallbackReason).toBe("USER_PLAIN");
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("skips drafts with hard-block codes when type is approve", async () => {
    const mixedDrafts = [
      {
        id: "d-regular",
        campaignId: "camp-1",
        recipientId: "rec-1",
        promptVersion: "fp-v1",
        status: "FLAGGED" as DraftStatus,
        flagReasons: [{ code: "TOO_LONG", message: "Too long" }],
      },
      {
        id: "d-forbidden",
        campaignId: "camp-1",
        recipientId: "rec-2",
        promptVersion: "fp-v1",
        status: "FLAGGED" as DraftStatus,
        flagReasons: [{ code: "FORBIDDEN_CONTENT", message: "Forbidden" }],
      },
      {
        id: "d-injection",
        campaignId: "camp-1",
        recipientId: "rec-3",
        promptVersion: "fp-v1",
        status: "FLAGGED" as DraftStatus,
        flagReasons: [{ code: "INJECTION_SUSPECTED", message: "Injection" }],
      },
    ];

    const { client, drafts: draftMap } = createFakeDb({
      campaigns: [baseCampaign],
      recipients,
      drafts: mixedDrafts,
    });

    const res = await bulkResolve("camp-1", { type: "approve" }, { db: client as any });
    expect(res).toEqual({ changed: 1, skippedHardBlocked: 2 });
    expect(draftMap.get("d-regular").status).toBe("APPROVED");
    expect(draftMap.get("d-forbidden").status).toBe("FLAGGED");
    expect(draftMap.get("d-injection").status).toBe("FLAGGED");
  });

  it("processes target drafts in chunks of 50, each chunk in its own short transaction", async () => {
    // Generate 105 flagged drafts
    const manyDrafts: any[] = [];
    const manyRecipients: any[] = [];
    for (let i = 1; i <= 105; i++) {
      const recId = `rec-chunk-${i}`;
      manyRecipients.push({
        id: recId,
        campaignId: "camp-1",
        email: `user${i}@test.com`,
        firstName: `User${i}`,
      });
      manyDrafts.push({
        id: `draft-chunk-${i}`,
        campaignId: "camp-1",
        recipientId: recId,
        promptVersion: "fp-v1",
        status: "FLAGGED" as DraftStatus,
        flagReasons: [{ code: "GREETING", message: "Greeting found" }],
        subject: `Sub ${i}`,
        body: `Body ${i}`,
      });
    }

    const { client, drafts: draftMap } = createFakeDb({
      campaigns: [baseCampaign],
      recipients: manyRecipients,
      drafts: manyDrafts,
    });

    const refreshFn = vi.fn(async () => ({ refreshed: false }));
    const res = await bulkResolve(
      "camp-1",
      { type: "approve" },
      { db: client as any, refreshCampaign: refreshFn }
    );

    expect(res).toEqual({ changed: 105, skippedHardBlocked: 0 });
    // 105 drafts in chunks of 50 = 3 chunks (50 + 50 + 5) -> $transaction called 3 times
    expect(client.$transaction).toHaveBeenCalledTimes(3);

    for (let i = 1; i <= 105; i++) {
      expect(draftMap.get(`draft-chunk-${i}`).status).toBe("APPROVED");
    }
  });
});

describe("drafts.ts - listDrafts", () => {
  const baseCampaign = {
    id: "camp-1",
    status: "EXCEPTION_REVIEW" as CampaignStatus,
    promptFingerprint: "fp-v1",
  };

  const recipients = [
    { id: "rec-1", campaignId: "camp-1", email: "a@test.com", firstName: "Alice" },
    { id: "rec-2", campaignId: "camp-1", email: "b@test.com", firstName: "Bob" },
    { id: "rec-3", campaignId: "camp-1", email: "c@test.com", firstName: "Carol" },
  ];

  const drafts = [
    {
      id: "draft-1",
      campaignId: "camp-1",
      recipientId: "rec-1",
      status: "FLAGGED" as DraftStatus,
      isSample: true,
      promptVersion: "fp-v1",
      subject: "Sub 1",
      body: "Body 1",
      aiIntro: "Intro 1",
      flagReasons: [],
      fallbackReason: null,
      resolvedBy: null,
    },
    {
      id: "draft-2",
      campaignId: "camp-1",
      recipientId: "rec-2",
      status: "APPROVED" as DraftStatus,
      isSample: false,
      promptVersion: "fp-v1",
      subject: "Sub 2",
      body: "Body 2",
      aiIntro: "Intro 2",
      flagReasons: null,
      fallbackReason: null,
      resolvedBy: "USER",
    },
    {
      id: "draft-3",
      campaignId: "camp-1",
      recipientId: "rec-3",
      status: "FLAGGED" as DraftStatus,
      isSample: false,
      promptVersion: "fp-v1",
      subject: "Sub 3",
      body: "Body 3",
      aiIntro: "Intro 3",
      flagReasons: [],
      fallbackReason: null,
      resolvedBy: null,
    },
    {
      id: "draft-old",
      campaignId: "camp-1",
      recipientId: "rec-1",
      status: "FLAGGED" as DraftStatus,
      isSample: true,
      promptVersion: "old-fp",
      subject: "Old Sub",
      body: "Old Body",
      aiIntro: null,
      flagReasons: null,
      fallbackReason: null,
      resolvedBy: null,
    },
  ];

  it("filters only drafts with current fingerprint and returns all expected fields", async () => {
    const { client } = createFakeDb({
      campaigns: [baseCampaign],
      recipients,
      drafts,
    });

    const list = await listDrafts("camp-1", {}, { db: client as any });
    expect(list).toHaveLength(3);
    expect(list.map((d) => d.id)).toEqual(["draft-1", "draft-2", "draft-3"]);
    expect(list[0]).toMatchObject({
      id: "draft-1",
      status: "FLAGGED",
      isSample: true,
      recipient: { email: "a@test.com", firstName: "Alice" },
      aiIntro: "Intro 1",
      subject: "Sub 1",
      body: "Body 1",
    });
  });

  it("filters by status and isSample", async () => {
    const { client } = createFakeDb({
      campaigns: [baseCampaign],
      recipients,
      drafts,
    });

    const flaggedSamples = await listDrafts("camp-1", { status: "FLAGGED", isSample: true }, {
      db: client as any,
    });
    expect(flaggedSamples).toHaveLength(1);
    expect(flaggedSamples[0].id).toBe("draft-1");
  });

  it("pages with limit and cursor", async () => {
    const { client } = createFakeDb({
      campaigns: [baseCampaign],
      recipients,
      drafts,
    });

    const page1 = await listDrafts("camp-1", { limit: 2 }, { db: client as any });
    expect(page1).toHaveLength(2);
    expect(page1.map((d) => d.id)).toEqual(["draft-1", "draft-2"]);

    const page2 = await listDrafts("camp-1", { limit: 2, cursor: page1[1].id }, {
      db: client as any,
    });
    expect(page2).toHaveLength(1);
    expect(page2[0].id).toBe("draft-3");
  });
});

describe("drafts.ts - getCampaignSummary", () => {
  const scheduledAt = new Date("2026-11-01T12:00:00Z");
  const baseCampaign = {
    id: "camp-1",
    status: "EXCEPTION_REVIEW" as CampaignStatus,
    errorMessage: null,
    scheduledAt,
    promptFingerprint: "fp-v1",
  };

  const recipients = [
    { id: "rec-1", campaignId: "camp-1", email: "a@test.com" },
    { id: "rec-2", campaignId: "camp-1", email: "b@test.com" },
    { id: "rec-3", campaignId: "camp-1", email: "c@test.com" },
  ];

  const drafts = [
    { id: "d-1", campaignId: "camp-1", promptVersion: "fp-v1", status: "READY" },
    { id: "d-2", campaignId: "camp-1", promptVersion: "fp-v1", status: "FLAGGED" },
    { id: "d-3", campaignId: "camp-1", promptVersion: "fp-v1", status: "APPROVED" },
    { id: "d-old", campaignId: "camp-1", promptVersion: "old-fp", status: "FLAGGED" },
  ];

  it("returns campaign details, recipient count, and draft counts for current fingerprint only", async () => {
    const { client } = createFakeDb({
      campaigns: [baseCampaign],
      recipients,
      drafts,
    });

    const summary = await getCampaignSummary("camp-1", { db: client as any });
    expect(summary.status).toBe("EXCEPTION_REVIEW");
    expect(summary.errorMessage).toBeNull();
    expect(summary.scheduledAt).toBe(scheduledAt);
    expect(summary.recipientCount).toBe(3);

    expect(summary.draftCounts.READY).toBe(1);
    expect(summary.draftCounts.FLAGGED).toBe(1); // d-old is ignored because promptVersion is old-fp
    expect(summary.draftCounts.APPROVED).toBe(1);
    expect(summary.draftCounts.FALLBACK).toBe(0);
    expect(summary.counts).toEqual(summary.draftCounts);
  });
});
