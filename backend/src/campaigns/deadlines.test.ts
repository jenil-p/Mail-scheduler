import { describe, expect, it, vi } from "vitest";
import { enforceDeadlines } from "./deadlines";
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
      findMany: vi.fn(async ({ where }: { where?: any }) => {
        let list = Array.from(campaigns.values());
        if (where?.status?.in) {
          list = list.filter((c) => where.status.in.includes(c.status));
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
        return list.map((d) => {
          const res = { ...d };
          if (include?.recipient) {
            res.recipient = recipients.get(d.recipientId) ?? null;
          }
          return res;
        });
      }),
      updateMany: vi.fn(async ({ where, data }: { where: any; data: any }) => {
        let count = 0;
        const targetIds = where.id?.in ?? (where.id ? [where.id] : []);
        for (const id of targetIds) {
          const d = drafts.get(id);
          if (!d) continue;
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
    $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(client)),
    _state: { campaigns, recipients, drafts },
  };

  return client as any;
}

describe("enforceDeadlines", () => {
  const finalizeLeadMs = 120_000; // 2 minutes
  const scheduledAt = new Date("2026-11-01T12:00:00Z");
  const pastDeadline = new Date("2026-11-01T11:59:00Z"); // 1 min before scheduledAt, past the 2 min lead deadline
  const beforeDeadline = new Date("2026-11-01T11:50:00Z"); // 10 min before scheduledAt, before deadline

  it("does nothing when now is before the deadline", async () => {
    const db = createFakeDb({
      campaigns: [
        {
          id: "c1",
          status: "GENERATING",
          scheduledAt,
          onUnresolved: "FALLBACK_TO_PLAIN",
          promptFingerprint: "fp1",
          subjectTemplate: "Sub",
          bodyTemplate: "Body",
        },
      ],
      drafts: [
        { id: "d1", campaignId: "c1", status: "PENDING", promptVersion: "fp1" },
      ],
    });

    const refresh = vi.fn();
    const result = await enforceDeadlines({
      db,
      clock: { now: () => beforeDeadline },
      ai: { finalizeLeadMs } as any,
      refresh,
    });

    expect(result.processedCampaigns).toBe(0);
    expect(result.resolvedDrafts).toBe(0);
    expect(db._state.drafts.get("d1").status).toBe("PENDING");
    expect(refresh).not.toHaveBeenCalled();
  });

  describe("Case a: SAMPLING, SAMPLE_REVIEW, PAUSED -> CANCELLED", () => {
    it.each(["SAMPLING", "SAMPLE_REVIEW", "PAUSED"] as CampaignStatus[])(
      "cancels campaign in %s at deadline with error message and calls refreshCampaign",
      async (status) => {
        const db = createFakeDb({
          campaigns: [
            {
              id: "c1",
              status,
              scheduledAt,
              onUnresolved: "FALLBACK_TO_PLAIN",
              promptFingerprint: "fp1",
            },
          ],
        });

        const refresh = vi.fn();
        const result = await enforceDeadlines({
          db,
          clock: { now: () => pastDeadline },
          ai: { finalizeLeadMs } as any,
          refresh,
        });

        expect(result.processedCampaigns).toBe(1);
        expect(result.cancelledCampaigns).toBe(1);

        const campaign = db._state.campaigns.get("c1");
        expect(campaign.status).toBe("CANCELLED");
        expect(campaign.errorMessage).toBe(
          "The scheduled time passed before this campaign was ready, so nothing was sent."
        );
        expect(refresh).toHaveBeenCalledWith("c1", expect.anything());
      }
    );
  });

  describe("Case b: GENERATING", () => {
    it("resolves PENDING/GENERATING drafts to FALLBACK under FALLBACK_TO_PLAIN with GENERATION_INCOMPLETE_AT_DEADLINE", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "GENERATING",
            scheduledAt,
            onUnresolved: "FALLBACK_TO_PLAIN",
            promptFingerprint: "fp1",
            subjectTemplate: "Hi {{first_name}}",
            bodyTemplate: "Hello from {{company}}",
          },
        ],
        recipients: [
          { id: "r1", email: "alice@example.com", firstName: "Alice", company: "Acme" },
          { id: "r2", email: "bob@example.com", firstName: "Bob", company: "Beta" },
        ],
        drafts: [
          { id: "d1", campaignId: "c1", recipientId: "r1", status: "PENDING", promptVersion: "fp1" },
          { id: "d2", campaignId: "c1", recipientId: "r2", status: "GENERATING", promptVersion: "fp1" },
        ],
      });

      const refresh = vi.fn();
      const result = await enforceDeadlines({
        db,
        clock: { now: () => pastDeadline },
        ai: { finalizeLeadMs } as any,
        refresh,
      });

      expect(result.processedCampaigns).toBe(1);
      expect(result.resolvedDrafts).toBe(2);

      const d1 = db._state.drafts.get("d1");
      expect(d1.status).toBe("FALLBACK");
      expect(d1.fallbackReason).toBe("GENERATION_INCOMPLETE_AT_DEADLINE");
      expect(d1.resolvedBy).toBe("SYSTEM");
      expect(d1.aiIntro).toBeNull();
      expect(d1.subject).toBe("Hi Alice");
      expect(d1.body).toBe("Hello from Acme");

      const d2 = db._state.drafts.get("d2");
      expect(d2.status).toBe("FALLBACK");
      expect(d2.fallbackReason).toBe("GENERATION_INCOMPLETE_AT_DEADLINE");
      expect(d2.subject).toBe("Hi Bob");

      expect(refresh).toHaveBeenCalledWith("c1", expect.anything());
    });

    it("resolves PENDING/GENERATING drafts to HELD under HOLD policy", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "GENERATING",
            scheduledAt,
            onUnresolved: "HOLD",
            promptFingerprint: "fp1",
          },
        ],
        drafts: [
          { id: "d1", campaignId: "c1", status: "PENDING", promptVersion: "fp1" },
          { id: "d2", campaignId: "c1", status: "GENERATING", promptVersion: "fp1" },
        ],
      });

      const refresh = vi.fn();
      const result = await enforceDeadlines({
        db,
        clock: { now: () => pastDeadline },
        ai: { finalizeLeadMs } as any,
        refresh,
      });

      expect(result.resolvedDrafts).toBe(2);
      expect(db._state.drafts.get("d1").status).toBe("HELD");
      expect(db._state.drafts.get("d1").resolvedBy).toBe("SYSTEM");
      expect(db._state.drafts.get("d2").status).toBe("HELD");
      expect(db._state.drafts.get("d2").resolvedBy).toBe("SYSTEM");
    });

    it("also resolves FLAGGED drafts in a GENERATING campaign", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "GENERATING",
            scheduledAt,
            onUnresolved: "FALLBACK_TO_PLAIN",
            promptFingerprint: "fp1",
            subjectTemplate: "Hi {{first_name}}",
            bodyTemplate: "Body",
          },
        ],
        recipients: [
          { id: "r1", firstName: "Alice" },
        ],
        drafts: [
          {
            id: "d1",
            campaignId: "c1",
            recipientId: "r1",
            status: "FLAGGED",
            flagReasons: [{ code: "TOO_LONG", detail: "Too long" }],
            promptVersion: "fp1",
          },
        ],
      });

      const refresh = vi.fn();
      const result = await enforceDeadlines({
        db,
        clock: { now: () => pastDeadline },
        ai: { finalizeLeadMs } as any,
        refresh,
      });

      expect(result.resolvedDrafts).toBe(1);
      const d1 = db._state.drafts.get("d1");
      expect(d1.status).toBe("FALLBACK");
      expect(d1.fallbackReason).toBe("UNRESOLVED_AT_DEADLINE");
      expect(d1.resolvedBy).toBe("SYSTEM");
      // Keep flagReasons for audit
      expect(d1.flagReasons).toEqual([{ code: "TOO_LONG", detail: "Too long" }]);
    });
  });

  describe("Case c: EXCEPTION_REVIEW", () => {
    it("resolves FLAGGED drafts to FALLBACK under FALLBACK_TO_PLAIN keeping flagReasons", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "EXCEPTION_REVIEW",
            scheduledAt,
            onUnresolved: "FALLBACK_TO_PLAIN",
            promptFingerprint: "fp1",
            subjectTemplate: "Subject",
            bodyTemplate: "Body",
          },
        ],
        recipients: [{ id: "r1" }],
        drafts: [
          {
            id: "d1",
            campaignId: "c1",
            recipientId: "r1",
            status: "FLAGGED",
            flagReasons: [{ code: "PROFANITY", detail: "bad word" }],
            promptVersion: "fp1",
          },
        ],
      });

      const refresh = vi.fn();
      const result = await enforceDeadlines({
        db,
        clock: { now: () => pastDeadline },
        ai: { finalizeLeadMs } as any,
        refresh,
      });

      expect(result.resolvedDrafts).toBe(1);
      const d1 = db._state.drafts.get("d1");
      expect(d1.status).toBe("FALLBACK");
      expect(d1.fallbackReason).toBe("UNRESOLVED_AT_DEADLINE");
      expect(d1.resolvedBy).toBe("SYSTEM");
      expect(d1.flagReasons).toEqual([{ code: "PROFANITY", detail: "bad word" }]);
      expect(refresh).toHaveBeenCalledWith("c1", expect.anything());
    });

    it("resolves FLAGGED drafts to HELD under HOLD policy", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "EXCEPTION_REVIEW",
            scheduledAt,
            onUnresolved: "HOLD",
            promptFingerprint: "fp1",
          },
        ],
        drafts: [
          {
            id: "d1",
            campaignId: "c1",
            status: "FLAGGED",
            promptVersion: "fp1",
          },
        ],
      });

      const refresh = vi.fn();
      const result = await enforceDeadlines({
        db,
        clock: { now: () => pastDeadline },
        ai: { finalizeLeadMs } as any,
        refresh,
      });

      expect(result.resolvedDrafts).toBe(1);
      expect(db._state.drafts.get("d1").status).toBe("HELD");
      expect(db._state.drafts.get("d1").resolvedBy).toBe("SYSTEM");
    });

    it("does not overwrite a draft that was resolved concurrently between read and update", async () => {
      const db = createFakeDb({
        campaigns: [
          {
            id: "c1",
            status: "EXCEPTION_REVIEW",
            scheduledAt,
            onUnresolved: "FALLBACK_TO_PLAIN",
            promptFingerprint: "fp1",
            subjectTemplate: "Subject",
            bodyTemplate: "Body",
          },
        ],
        recipients: [{ id: "r1" }],
        drafts: [
          {
            id: "d1",
            campaignId: "c1",
            recipientId: "r1",
            status: "FLAGGED",
            promptVersion: "fp1",
          },
        ],
      });

      // Hook into findMany so that concurrently before update, draft resolves to APPROVED
      const origFindMany = db.generatedDraft.findMany;
      db.generatedDraft.findMany = vi.fn(async (args: any) => {
        const res = await origFindMany(args);
        // Concurrent approval by user
        const d = db._state.drafts.get("d1");
        d.status = "APPROVED";
        d.resolvedBy = "USER";
        return res;
      });

      const refresh = vi.fn();
      const result = await enforceDeadlines({
        db,
        clock: { now: () => pastDeadline },
        ai: { finalizeLeadMs } as any,
        refresh,
      });

      expect(result.resolvedDrafts).toBe(0);
      const d1 = db._state.drafts.get("d1");
      expect(d1.status).toBe("APPROVED");
      expect(d1.resolvedBy).toBe("USER");
    });
  });
});
