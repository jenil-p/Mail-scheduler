import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { config } from "../config";
import { prisma } from "../db/pool";
import { sendEmail } from "../email/sender";
import { RateLimiter } from "./rateLimiter";
import { redisConnection, emailQueue } from "./queue";

const redisForRateLimiter = new Redis({
  host: config.redis.host,
  port: config.redis.port,
});

const rateLimiter = new RateLimiter(redisForRateLimiter);

export interface EmailJobData {
  jobId: string; // UUID of the EmailJob in database
  recipientEmail: string;
  subject: string;
  body: string;
  senderEmail: string;
}

/**
 * Process a single email job:
 * 1. Check idempotency (already sent?)
 * 2. Check rate limit (sliding window log — hourly, per user)
 * 3. Send email via Ethereal
 * 4. Update DB status
 */
async function processEmail(job: Job<EmailJobData>): Promise<void> {
  const { jobId, recipientEmail, subject, body, senderEmail } = job.data;

  console.log(`[Worker] Processing job ${job.id} — sending to ${recipientEmail}`);

  const emailJob = await prisma.emailJob.findUnique({
    where: { id: jobId },
  });

  if (!emailJob) {
    console.warn(`[Worker] Job ${job.id}: email_job ${jobId} not found in DB, skipping.`);
    return;
  }

  if (emailJob.status === "sent") {
    console.log(`[Worker] Job ${job.id}: email already sent (idempotency), skipping.`);
    return;
  }

  // Sliding window log rate limit — hourly, per sender
  const canSend = await rateLimiter.tryIncrement(senderEmail);

  if (!canSend) {
    // We're rate limited — reschedule this job to when the window rolls over
    const msUntilNextWindow = await rateLimiter.getMsUntilNextWindow(senderEmail);
    console.log(
      `[Worker] Job ${job.id}: rate limited for ${senderEmail}, ` +
      `rescheduling in ${Math.round(msUntilNextWindow / 1000)}s`
    );

    // Update DB status
    await prisma.emailJob.update({
      where: { id: jobId },
      data: { status: "rate_limited" },
    });

    // Re-add to queue with delay into next window
    // (plus a small random offset to spread out the retries)
    const jitter = Math.random() * 60_000; // up to 1 minute jitter
    await emailQueue.add(
      "email-job",
      job.data,
      {
        delay: msUntilNextWindow + jitter,
        jobId: `${jobId}-retry-${Date.now()}`,
      }
    );

    // Mark original job as completed (the retry will handle it)
    return;
  }

  const result = await sendEmail(recipientEmail, subject, body, senderEmail);

  if (result.success) {
    await prisma.emailJob.update({
      where: { id: jobId },
      data: {
        status: "sent",
        sentAt: new Date(),
      },
    });
    console.log(`[Worker] Job ${job.id}: successfully sent to ${recipientEmail}`);
  } else {
    await prisma.emailJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        errorMessage: result.error,
      },
    });
    console.error(`[Worker] Job ${job.id}: failed for ${recipientEmail}: ${result.error}`);

    // Throw to trigger BullMQ retry mechanism
    throw new Error(result.error);
  }
}

/**
 * Create and start the BullMQ worker.
 * The worker will automatically recover unfinished jobs after a server restart
 * because BullMQ stores them in Redis with persistence.
 */
export function createEmailWorker(): Worker<EmailJobData> {
  const worker = new Worker<EmailJobData>("email-scheduler", processEmail, {
    connection: redisConnection,
    concurrency: config.worker.concurrency,
    limiter: {
      max: 1,
      duration: config.worker.minDelayMs, // minimum delay between sends
    },
  });

  worker.on("ready", () => {
    console.log(`[Worker] BullMQ worker ready — concurrency: ${config.worker.concurrency}, min delay: ${config.worker.minDelayMs}ms`);
  });

  worker.on("completed", (job) => {
    console.log(`[Worker] Job ${job.id} completed.`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed after retries: ${err.message}`);
  });

  worker.on("error", (err) => {
    console.error(`[Worker] Error:`, err.message);
  });

  return worker;
}
