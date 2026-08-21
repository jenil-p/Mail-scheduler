import { prisma } from "../db/pool";
import { emailQueue } from "./queue";

/**
 * this is for if redis stays crashed for long time and in database we have some pending jobs but incase we lost them from
 * redis (very less likely to happen) but yah ...
 * 
 * This may take time for larger number of pending payments but, again this is trade off b/w time complexity and probabilistic job loss...
 */
export async function recoverPendingJobs(): Promise<{
  recovered: number;
  skipped: number;
}> {
  console.log(
    "[Recovery] Checking for pending email jobs that need to be re-queued..."
  );

  // Fetch all pending jobs (ordered by scheduledAt so past-due jobs go first)
  const pendingJobs = await prisma.emailJob.findMany({
    where: { status: "pending" },
    orderBy: { scheduledAt: "asc" },
    select: {
      id: true,
      recipientEmail: true,
      subject: true,
      body: true,
      senderEmail: true,
      scheduledAt: true,
    },
  });

  if (pendingJobs.length === 0) {
    console.log("[Recovery] No pending jobs found — nothing to recover.");
    return { recovered: 0, skipped: 0 };
  }

  console.log(`[Recovery] Found ${pendingJobs.length} pending job(s) to re-queue.`);

  // Build the bulk payload
  const now = Date.now();
  const jobsToQueue = pendingJobs.map((job) => {
    const delayMs = Math.max(0, job.scheduledAt.getTime() - now);
    return {
      name: "email-job",
      data: {
        jobId: job.id,
        recipientEmail: job.recipientEmail,
        subject: job.subject,
        body: job.body,
        senderEmail: job.senderEmail,
      },
      opts: {
        delay: delayMs,
        jobId: job.id, // dedup key
      },
    };
  });

  const results = await emailQueue.addBulk(jobsToQueue);
  const recovered = results.length;

  console.log(
    `[Recovery] Done — processed ${recovered} pending job(s) (BullMQ dedup handles any duplicates)`
  );

  return { recovered, skipped: 0 };
}
