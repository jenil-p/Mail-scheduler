-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('pending', 'sent', 'failed', 'rate_limited');

-- CreateTable
CREATE TABLE "email_jobs" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "recipient_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sender_email" TEXT NOT NULL,
    "scheduled_at" TIMESTAMPTZ NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'pending',
    "sent_at" TIMESTAMPTZ,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "email_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_jobs_status_idx" ON "email_jobs"("status");

-- CreateIndex
CREATE INDEX "email_jobs_scheduled_at_idx" ON "email_jobs"("scheduled_at");

-- CreateIndex
CREATE INDEX "email_jobs_sender_email_status_idx" ON "email_jobs"("sender_email", "status");

-- CreateIndex
CREATE INDEX "email_jobs_user_id_status_idx" ON "email_jobs"("user_id", "status");
