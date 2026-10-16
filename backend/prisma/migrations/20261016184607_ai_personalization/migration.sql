-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SAMPLING', 'SAMPLE_REVIEW', 'GENERATING', 'EXCEPTION_REVIEW', 'SCHEDULED', 'SENDING', 'COMPLETED', 'PAUSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReviewMode" AS ENUM ('SAMPLE', 'FULL');

-- CreateEnum
CREATE TYPE "UnresolvedPolicy" AS ENUM ('FALLBACK_TO_PLAIN', 'HOLD');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('PENDING', 'GENERATING', 'READY', 'FLAGGED', 'FALLBACK', 'APPROVED', 'HELD', 'QUEUED');

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject_template" TEXT NOT NULL,
    "body_template" TEXT NOT NULL,
    "template_hash" TEXT NOT NULL,
    "link_url" TEXT NOT NULL,
    "unsubscribe_url" TEXT NOT NULL,
    "ai_enabled" BOOLEAN NOT NULL DEFAULT false,
    "ai_instruction" TEXT,
    "prompt_fingerprint" TEXT,
    "llm_model" TEXT,
    "prompt_template_version" TEXT,
    "approved_prompt_version" TEXT,
    "review_mode" "ReviewMode" NOT NULL DEFAULT 'SAMPLE',
    "on_unresolved" "UnresolvedPolicy" NOT NULL DEFAULT 'FALLBACK_TO_PLAIN',
    "scheduled_at" TIMESTAMPTZ NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "first_name" TEXT,
    "company" TEXT,
    "role" TEXT,
    "note" TEXT,
    "extra" JSONB,
    "has_personalization_data" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_drafts" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "email_job_id" UUID,
    "ai_intro" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'PENDING',
    "flag_reasons" JSONB,
    "fallback_reason" TEXT,
    "is_sample" BOOLEAN NOT NULL DEFAULT false,
    "resolved_by" TEXT,
    "model" TEXT,
    "prompt_version" TEXT NOT NULL,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "latency_ms" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "rate_limit_hits" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "generated_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_user_id_status_idx" ON "campaigns"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_campaign_id_email_key" ON "campaign_recipients"("campaign_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "generated_drafts_email_job_id_key" ON "generated_drafts"("email_job_id");

-- CreateIndex
CREATE INDEX "generated_drafts_campaign_id_prompt_version_status_idx" ON "generated_drafts"("campaign_id", "prompt_version", "status");

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_drafts" ADD CONSTRAINT "generated_drafts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_drafts" ADD CONSTRAINT "generated_drafts_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "campaign_recipients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_drafts" ADD CONSTRAINT "generated_drafts_email_job_id_fkey" FOREIGN KEY ("email_job_id") REFERENCES "email_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

