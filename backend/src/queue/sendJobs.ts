/**
 * Shared email send job enqueueing (parity with routes/schedule.ts).
 */
import { emailQueue } from "./queue";

export const EMAIL_JOB_NAME = "email-job";

export interface SendJobPayload {
  id?: string;
  jobId?: string;
  recipientEmail: string;
  subject: string;
  body: string;
  senderEmail: string;
}

export interface EnqueueSendJobOptions {
  delayMs: number;
}

export interface EnqueueSendJobDeps {
  queue?: {
    add: (name: string, data: any, opts: any) => Promise<unknown>;
  };
  addJob?: (name: string, data: any, opts: any) => Promise<unknown>;
  addSendJob?: (
    job: {
      jobId: string;
      recipientEmail: string;
      subject: string;
      body: string;
      senderEmail: string;
    },
    opts: { delay: number; jobId: string }
  ) => Promise<unknown>;
}

export async function enqueueSendJob(
  job: SendJobPayload,
  options: EnqueueSendJobOptions,
  deps?: EnqueueSendJobDeps
): Promise<unknown> {
  const jobId = job.id ?? job.jobId;
  if (!jobId) {
    throw new Error("enqueueSendJob requires an id or jobId");
  }

  const data = {
    jobId,
    recipientEmail: job.recipientEmail,
    subject: job.subject,
    body: job.body,
    senderEmail: job.senderEmail,
  };

  const jobOpts = {
    delay: options.delayMs,
    jobId,
  };

  if (deps?.addSendJob) {
    return deps.addSendJob(data, jobOpts);
  }

  if (deps?.addJob) {
    return deps.addJob(EMAIL_JOB_NAME, data, jobOpts);
  }

  if (deps?.queue) {
    return deps.queue.add(EMAIL_JOB_NAME, data, jobOpts);
  }

  return emailQueue.add(EMAIL_JOB_NAME, data, jobOpts);
}
