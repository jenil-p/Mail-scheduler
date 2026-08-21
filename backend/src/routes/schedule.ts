import { Router, Request, Response } from "express";
import { prisma } from "../db/pool";
import { emailQueue } from "../queue/queue";
import { authenticate } from "../middleware/auth";
import { requireFields } from "../middleware/validate";

const router = Router();

router.post( "/", authenticate,
  requireFields("recipients", "subject", "body", "senderEmail", "scheduledAt"),
  async (req: Request, res: Response) => {
    try {
      const {
        recipients,
        subject,
        body,
        senderEmail,
        scheduledAt,
        delayBetweenEmails,
      } = req.body;

      if (!Array.isArray(recipients) || recipients.length === 0) {
        res.status(400).json({
          success: false,
          error: "recipients must be a non-empty array of email addresses",
        });
        return;
      }

      // Validate email addresses
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const invalidEmails = recipients.filter((e: string) => !emailRegex.test(e));
      if (invalidEmails.length > 0) {
        res.status(400).json({
          success: false,
          error: `Invalid email addresses: ${invalidEmails.join(", ")}`,
        });
        return;
      }

      const scheduleTime = new Date(scheduledAt);
      if (isNaN(scheduleTime.getTime())) {
        res.status(400).json({
          success: false,
          error: "Invalid scheduledAt date",
        });
        return;
      }

      const now = new Date();
      const delay =  Math.max(delayBetweenEmails ?? 2000, 2000); // default 2s between emails

      const createdJobs = [];
      const createdJobIds: string[] = [];

      // Create email jobs in DB and schedule them in BullMQ
      for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i];

        // Calculate individual send time with spacing
        const sendTime = new Date(scheduleTime.getTime() + i * delay);
        const delayMs = Math.max(0, sendTime.getTime() - now.getTime());

        // Create DB record
        const emailJob = await prisma.emailJob.create({
          data: {
            userId: req.user!.email,
            recipientEmail: recipient,
            subject,
            body,
            senderEmail,
            scheduledAt: sendTime,
            status: "pending",
          },
        });

        createdJobIds.push(emailJob.id);

        try {
          // Add to BullMQ queue with delay
          await emailQueue.add(
            "email-job",
            {
              jobId: emailJob.id,
              recipientEmail: recipient,
              subject,
              body,
              senderEmail,
            },
            {
              delay: delayMs,
              jobId: emailJob.id, // unique jobId to prevent duplicates
            }
          );

          createdJobs.push({
            id: emailJob.id,
            recipientEmail: recipient,
            scheduledAt: sendTime.toISOString(),
          });
        } catch (queueError: any) {
          // BullMQ add() failed - clean up the DB record to avoid orphaned pending jobs
          console.error(
            `[Schedule] BullMQ add() failed for job ${emailJob.id}: ${queueError.message}. Cleaning up DB record.`
          );
          await prisma.emailJob.delete({ where: { id: emailJob.id } });
        }
      }

      console.log(
        `[Schedule] Created ${createdJobs.length} email jobs, first at ${scheduleTime.toISOString()}`
      );

      res.status(201).json({
        success: true,
        data: {
          total: createdJobs.length,
          jobs: createdJobs,
        },
        message: `Scheduled ${createdJobs.length} emails`,
      });
    } catch (error: any) {
      console.error("[Schedule] Error:", error.message);
      res.status(500).json({
        success: false,
        error: "Failed to schedule emails",
      });
    }
  }
);

export default router;
