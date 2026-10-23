import { describe, expect, it, vi } from "vitest";
import { ensureGenerateJob, reconcileSends } from "./reconcile";
import { GENERATE_JOB_NAME } from "../queue/generateQueue";
import type { GenerateJobData } from "../queue/generateJob";

describe("ensureGenerateJob", () => {
  const data: GenerateJobData = {
    draftId: "d123",
    campaignId: "c123",
    recipientId: "r123",
    isSample: false,
  };

  it("removes completed job and adds new job", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const getJob = vi.fn().mockResolvedValue({
      getState: vi.fn().mockResolvedValue("completed"),
      remove,
    });
    const addJob = vi.fn().mockResolvedValue(undefined);

    const outcome = await ensureGenerateJob(
      { draftId: data.draftId, data, attempts: 3 },
      { getJob, addJob }
    );

    expect(outcome).toBe("added");
    expect(remove).toHaveBeenCalled();
    expect(addJob).toHaveBeenCalledWith(
      GENERATE_JOB_NAME,
      data,
      expect.objectContaining({ jobId: "d123", attempts: 3 })
    );
  });

  it("removes failed job and adds new job", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const getJob = vi.fn().mockResolvedValue({
      getState: vi.fn().mockResolvedValue("failed"),
      remove,
    });
    const addJob = vi.fn().mockResolvedValue(undefined);

    const outcome = await ensureGenerateJob(
      { draftId: data.draftId, data, attempts: 3 },
      { getJob, addJob }
    );

    expect(outcome).toBe("added");
    expect(remove).toHaveBeenCalled();
    expect(addJob).toHaveBeenCalled();
  });

  it.each(["waiting", "active", "delayed", "prioritized", "waiting-children"])(
    "skips adding when job is in live state: %s",
    async (liveState) => {
      const remove = vi.fn().mockResolvedValue(undefined);
      const getJob = vi.fn().mockResolvedValue({
        getState: vi.fn().mockResolvedValue(liveState),
        remove,
      });
      const addJob = vi.fn().mockResolvedValue(undefined);

      const outcome = await ensureGenerateJob(
        { draftId: data.draftId, data, attempts: 3 },
        { getJob, addJob }
      );

      expect(outcome).toBe("skipped_live");
      expect(remove).not.toHaveBeenCalled();
      expect(addJob).not.toHaveBeenCalled();
    }
  );

  it("adds new job when no job exists", async () => {
    const getJob = vi.fn().mockResolvedValue(undefined);
    const addJob = vi.fn().mockResolvedValue(undefined);

    const outcome = await ensureGenerateJob(
      { draftId: data.draftId, data, attempts: 3 },
      { getJob, addJob }
    );

    expect(outcome).toBe("added");
    expect(addJob).toHaveBeenCalledWith(
      GENERATE_JOB_NAME,
      data,
      expect.objectContaining({ jobId: "d123", attempts: 3 })
    );
  });
});

describe("reconcileSends", () => {
  it("ignores rate_limited, sent and failed rows, and queries only status pending", async () => {
    const db = {
      campaign: {
        findMany: vi.fn().mockResolvedValue([{ id: "c1" }]),
      },
      emailJob: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(db)),
    } as any;

    await reconcileSends(undefined, { db });

    expect(db.emailJob.findMany).toHaveBeenCalledWith({
      where: {
        status: "pending",
        generatedDraft: {
          campaignId: { in: ["c1"] },
        },
      },
      select: {
        id: true,
        recipientEmail: true,
        subject: true,
        body: true,
        senderEmail: true,
        scheduledAt: true,
      },
    });
  });

  it("adds missing send jobs for pending rows", async () => {
    const scheduledAt = new Date("2026-12-01T10:00:00Z");
    const db = {
      campaign: {
        findUnique: vi.fn().mockResolvedValue({ id: "c1", status: "SCHEDULED" }),
      },
      emailJob: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "j1",
            recipientEmail: "r1@example.com",
            subject: "Subject 1",
            body: "Body 1",
            senderEmail: "sender@example.com",
            scheduledAt,
          },
        ]),
      },
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(db)),
    } as any;

    const getJob = vi.fn().mockResolvedValue(null);
    const addJob = vi.fn().mockResolvedValue(undefined);
    const clock = { now: () => new Date("2026-12-01T09:00:00Z") }; // 1h before

    const result = await reconcileSends("c1", { db, getJob, addJob, clock });

    expect(result.reconciledCount).toBe(1);
    expect(result.jobIds).toEqual(["j1"]);
    expect(addJob).toHaveBeenCalledWith(
      "email-job",
      {
        jobId: "j1",
        recipientEmail: "r1@example.com",
        subject: "Subject 1",
        body: "Body 1",
        senderEmail: "sender@example.com",
      },
      {
        delay: 3600000,
        jobId: "j1",
      }
    );
  });

  it("does not remove or re-add completed or failed jobs, counts and logs pending rows with an existing finished job", async () => {
    const scheduledAt = new Date("2026-12-01T10:00:00Z");
    const db = {
      campaign: {
        findUnique: vi.fn().mockResolvedValue({ id: "c1", status: "SENDING" }),
      },
      emailJob: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "j1",
            recipientEmail: "r1@example.com",
            subject: "S",
            body: "B",
            senderEmail: "sender@example.com",
            scheduledAt,
          },
        ]),
      },
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(db)),
    } as any;

    const remove = vi.fn().mockResolvedValue(undefined);
    const getJob = vi.fn().mockResolvedValue({
      getState: vi.fn().mockResolvedValue("completed"),
      remove,
    });
    const addJob = vi.fn().mockResolvedValue(undefined);
    const clock = { now: () => new Date("2026-12-01T11:00:00Z") }; // past due -> delay 0
    const logger = { info: vi.fn(), error: vi.fn() };

    const result = await reconcileSends("c1", { db, getJob, addJob, clock, logger });

    expect(result.reconciledCount).toBe(0);
    expect(remove).not.toHaveBeenCalled();
    expect(addJob).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("pending rows with an existing finished job: 1")
    );
  });

  it.each(["waiting", "active", "delayed", "prioritized", "waiting-children"])(
    "skips adding when job is already live in state: %s",
    async (liveState) => {
      const db = {
        campaign: {
          findUnique: vi.fn().mockResolvedValue({ id: "c1", status: "SCHEDULED" }),
        },
        emailJob: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "j1",
              recipientEmail: "r1@example.com",
              subject: "S",
              body: "B",
              senderEmail: "sender@example.com",
              scheduledAt: new Date(),
            },
          ]),
        },
        $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(db)),
      } as any;

      const remove = vi.fn();
      const getJob = vi.fn().mockResolvedValue({
        getState: vi.fn().mockResolvedValue(liveState),
        remove,
      });
      const addJob = vi.fn();

      const result = await reconcileSends("c1", { db, getJob, addJob });

      expect(result.reconciledCount).toBe(0);
      expect(remove).not.toHaveBeenCalled();
      expect(addJob).not.toHaveBeenCalled();
    }
  );

  it("runs sweep pass in $transaction for campaigns with promptFingerprint", async () => {
    let txCalled = false;
    const db = {
      campaign: {
        findUnique: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "u1",
          status: "SCHEDULED",
          promptFingerprint: "fp1",
          scheduledAt: new Date(),
        }),
      },
      emailJob: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      generatedDraft: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => {
        txCalled = true;
        return cb(db);
      }),
    } as any;

    const result = await reconcileSends("c1", { db });
    expect(txCalled).toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(result.reconciledCount).toBe(0);
  });

  it("ignores campaigns not in SCHEDULED or SENDING", async () => {
    const db = {
      campaign: {
        findUnique: vi.fn().mockResolvedValue({ id: "c1", status: "GENERATING" }),
      },
      emailJob: {
        findMany: vi.fn(),
      },
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(db)),
    } as any;

    const result = await reconcileSends("c1", { db });
    expect(result.reconciledCount).toBe(0);
    expect(db.emailJob.findMany).not.toHaveBeenCalled();
  });
});
