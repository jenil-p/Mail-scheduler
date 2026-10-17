import { describe, expect, it, vi } from "vitest";
import { ensureGenerateJob } from "./reconcile";
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
