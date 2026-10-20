import { describe, expect, it, vi } from "vitest";
import { enqueueSendJob, EMAIL_JOB_NAME } from "./sendJobs";

describe("sendJobs", () => {
  it("enqueues a job with identical name, data shape and opts as schedule route", async () => {
    const add = vi.fn().mockResolvedValue({ id: "mock-job-id" });
    const mockQueue = { add };

    const jobPayload = {
      id: "test-job-id-1",
      recipientEmail: "alice@example.com",
      subject: "Test Subject",
      body: "<p>Test Body</p>",
      senderEmail: "Sendly Scheduler <scheduler@sendly.local>",
    };

    await enqueueSendJob(jobPayload, { delayMs: 4000 }, { queue: mockQueue });

    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0];

    expect(name).toBe(EMAIL_JOB_NAME);
    expect(name).toBe("email-job");

    // Exact data shape matching routes/schedule.ts
    expect(data).toEqual({
      jobId: "test-job-id-1",
      recipientEmail: "alice@example.com",
      subject: "Test Subject",
      body: "<p>Test Body</p>",
      senderEmail: "Sendly Scheduler <scheduler@sendly.local>",
    });

    // Exact opts matching routes/schedule.ts: { delay: delayMs, jobId: emailJob.id }
    expect(opts).toEqual({
      delay: 4000,
      jobId: "test-job-id-1",
    });
  });

  it("supports addJob and addSendJob injected dependencies", async () => {
    const addJob = vi.fn().mockResolvedValue(undefined);
    await enqueueSendJob(
      {
        id: "job-2",
        recipientEmail: "bob@example.com",
        subject: "Subject",
        body: "Body",
        senderEmail: "sender@example.com",
      },
      { delayMs: 1000 },
      { addJob }
    );

    expect(addJob).toHaveBeenCalledWith(
      "email-job",
      expect.objectContaining({ jobId: "job-2", recipientEmail: "bob@example.com" }),
      { delay: 1000, jobId: "job-2" }
    );

    const addSendJob = vi.fn().mockResolvedValue(undefined);
    await enqueueSendJob(
      {
        jobId: "job-3",
        recipientEmail: "carol@example.com",
        subject: "Subject 3",
        body: "Body 3",
        senderEmail: "sender@example.com",
      },
      { delayMs: 2500 },
      { addSendJob }
    );

    expect(addSendJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-3", recipientEmail: "carol@example.com" }),
      { delay: 2500, jobId: "job-3" }
    );
  });

  it("throws when job has neither id nor jobId", async () => {
    await expect(
      enqueueSendJob(
        {
          recipientEmail: "dave@example.com",
          subject: "Sub",
          body: "Body",
          senderEmail: "sender@example.com",
        } as any,
        { delayMs: 0 },
        { addJob: vi.fn() }
      )
    ).rejects.toThrow("enqueueSendJob requires an id or jobId");
  });
});
