import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import Redis from "ioredis";
import type { Worker } from "bullmq";
import { config } from "../config";
import type { PrismaClient } from "../generated/prisma/client";
import campaignsRouter from "./campaigns";
import { setCampaignRuntimeForTesting, closeCampaignRuntime } from "../campaigns/runtime";
import { createGenerateWorker } from "../queue/generateWorker";
import { executeCampaignTickRun } from "../campaigns/tick";
import { getGenerateQueue } from "../queue/generateQueue";
import { emailQueue } from "../queue/queue";
import { MockLlmClient } from "../ai/llm/mock";
import { resolveModelName } from "../ai/llm";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testRedisHost = process.env.TEST_REDIS_HOST;
const testRedisPort = process.env.TEST_REDIS_PORT;

const suite = testDatabaseUrl && testRedisHost && testRedisPort ? describe : describe.skip;

suite("campaigns HTTP API (integration)", () => {
  let prisma: PrismaClient;
  let redis: Redis;
  const userAEmail = "user-a@example.com";
  const userBEmail = "user-b@example.com";
  let tokenUserA: string;
  let tokenUserB: string;

  const createdCampaignIds: string[] = [];
  const workers: Worker[] = [];

  // Main test app with campaigns router mounted BEFORE global 10mb parser
  const app = express();
  app.use("/api/campaigns", campaignsRouter);
  app.use(express.json({ limit: "10mb" }));

  // App simulating AI personalization disabled (no campaign router mounted)
  const appDisabled = express();
  appDisabled.use(express.json({ limit: "10mb" }));

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.REDIS_HOST = testRedisHost;
    process.env.REDIS_PORT = testRedisPort;

    // Raise rate limits and set compact sample size for rapid integration test execution
    config.ai.rateLimitPerMin = 1000;
    config.ai.sampleSize = 2;

    const { prisma: client } = await import("../db/pool");
    prisma = client;

    redis = new Redis({
      host: testRedisHost,
      port: Number(testRedisPort),
      maxRetriesPerRequest: null,
    });

    await redis.del("bull:generate:limiter").catch(() => {});
    const keys = await redis.keys("llm:*");
    if (keys.length > 0) await redis.del(...keys);

    tokenUserA = jwt.sign(
      { email: userAEmail, name: "User A", id: "user-a-id" },
      config.jwt.secret,
      { expiresIn: "1h" }
    );

    tokenUserB = jwt.sign(
      { email: userBEmail, name: "User B", id: "user-b-id" },
      config.jwt.secret,
      { expiresIn: "1h" }
    );
  });

  afterEach(async () => {
    for (const w of workers) {
      await w.close().catch(() => {});
    }
    workers.length = 0;
    setCampaignRuntimeForTesting(null);

    await redis.del("bull:generate:limiter").catch(() => {});
    const keys = await redis.keys("llm:*");
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    await closeCampaignRuntime();
    if (createdCampaignIds.length > 0) {
      await prisma.emailJob.deleteMany({
        where: { generatedDraft: { campaignId: { in: createdCampaignIds } } },
      }).catch(() => {});
      await prisma.campaign.deleteMany({
        where: { id: { in: createdCampaignIds } },
      }).catch(() => {});
    }
    const queue = getGenerateQueue();
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close().catch(() => {});
    await redis?.quit().catch(() => {});
    await prisma.$disconnect();
  });

  describe("POST /api/campaigns creation & validation", () => {
    it("creates campaign with valid CSV -> 201", async () => {
      const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      const csv = "email,first_name,company\nalice@example.com,Alice,Acme\nbob@example.com,Bob,Beta";

      const res = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "Test Campaign 1",
          subjectTemplate: "Hi {{first_name}}",
          bodyTemplate: "Hello {{first_name}} at {{company}}. {{ai_intro}} Visit {{link}} or {{unsubscribe_link}}.",
          linkUrl: "https://example.com/promo",
          unsubscribeUrl: "https://example.com/unsub",
          aiEnabled: true,
          aiInstruction: "Friendly tone",
          scheduledAt,
          csv,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.campaignId).toBeTruthy();
      expect(res.body.data.status).toBe("DRAFT");
      expect(res.body.data.recipients.accepted).toBe(2);
      expect(res.body.data.recipients.rejectedCount).toBe(0);
      createdCampaignIds.push(res.body.data.campaignId);

      const dbCampaign = await prisma.campaign.findUnique({
        where: { id: res.body.data.campaignId },
      });
      expect(dbCampaign).toBeDefined();
      expect(dbCampaign?.userId).toBe(userAEmail);
      expect(dbCampaign?.status).toBe("DRAFT");
    });

    it("dryRun true -> 200 with report and no rows created in database", async () => {
      const countBefore = await prisma.campaign.count();
      const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      const csv = "email,first_name\ncharlie@example.com,Charlie";

      const res = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "Dry Run Campaign",
          subjectTemplate: "Hi {{first_name}}",
          bodyTemplate: "Content here. {{unsubscribe_link}}",
          linkUrl: "https://example.com",
          unsubscribeUrl: "https://example.com/unsub",
          aiEnabled: false,
          scheduledAt,
          csv,
          dryRun: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.errors).toEqual([]);
      expect(res.body.data.rejectedCount).toBe(0);

      const countAfter = await prisma.campaign.count();
      expect(countAfter).toBe(countBefore);
    });

    it("blocking problem: template errors -> 422 with details", async () => {
      const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      const csv = "email\nalice@example.com";

      const res = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "Bad Template",
          subjectTemplate: "Hi {{unknown_variable}}",
          bodyTemplate: "Missing unsubscribe",
          linkUrl: "https://example.com",
          unsubscribeUrl: "https://example.com/unsub",
          aiEnabled: false,
          scheduledAt,
          csv,
        });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error.details).toBeDefined();
      expect(res.body.error.details.errors.length).toBeGreaterThan(0);
    });

    it("blocking problem: reserved CSV column -> 422 with details", async () => {
      const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      const csv = "email,ai_intro\nalice@example.com,Reserved";

      const res = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "Reserved Column",
          subjectTemplate: "Hi",
          bodyTemplate: "Body {{unsubscribe_link}}",
          linkUrl: "https://example.com",
          unsubscribeUrl: "https://example.com/unsub",
          aiEnabled: false,
          scheduledAt,
          csv,
        });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("RESERVED_COLUMN");
      expect(res.body.error.details.errors[0].code).toBe("RESERVED_COLUMN");
    });

    it("blocking problem: past/too-soon scheduledAt -> 422 with SCHEDULE_TOO_SOON", async () => {
      const pastScheduledAt = new Date(Date.now() + 10_000).toISOString(); // 10s is < 5min
      const csv = "email\nalice@example.com";

      const res = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "Too Soon",
          subjectTemplate: "Hi",
          bodyTemplate: "Body {{unsubscribe_link}}",
          linkUrl: "https://example.com",
          unsubscribeUrl: "https://example.com/unsub",
          aiEnabled: false,
          scheduledAt: pastScheduledAt,
          csv,
        });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("SCHEDULE_TOO_SOON");
    });

    it("blocking problem: reviewMode FULL not available -> 422 with FULL_REVIEW_NOT_AVAILABLE", async () => {
      const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      const csv = "email\nalice@example.com";

      const res = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "Full Review Not Available",
          subjectTemplate: "Hi",
          bodyTemplate: "Body {{ai_intro}} {{unsubscribe_link}}",
          linkUrl: "https://example.com",
          unsubscribeUrl: "https://example.com/unsub",
          aiEnabled: true,
          reviewMode: "FULL",
          scheduledAt,
          csv,
        });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("FULL_REVIEW_NOT_AVAILABLE");
      expect(res.body.error.message).toBe("Full review of every draft is not available yet; use SAMPLE");
    });

    it("oversized body -> 413 PAYLOAD_TOO_LARGE", async () => {
      const hugeString = "x".repeat(1.2 * 1024 * 1024);

      const res = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "Huge Payload",
          subjectTemplate: "Hi",
          bodyTemplate: hugeString,
          linkUrl: "https://example.com",
          unsubscribeUrl: "https://example.com/unsub",
          aiEnabled: false,
          scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
          csv: "email\nalice@example.com",
        });

      expect(res.status).toBe(413);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    });

    it("malformed JSON body -> 400 INVALID_JSON", async () => {
      const res = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .set("Content-Type", "application/json")
        .send('{"name": "Bad JSON", ');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("INVALID_JSON");
    });

    it("no Authorization header with an oversized body returns 401 (not 413)", async () => {
      const hugeString = "x".repeat(1.2 * 1024 * 1024);

      try {
        const res = await request(app)
          .post("/api/campaigns")
          .send({
            name: "Huge Payload",
            bodyTemplate: hugeString,
          });

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
      } catch (err: any) {
        if (err.code !== "ECONNRESET") throw err;
      }
    });

    it("no Authorization header with a malformed JSON body returns 401 (not 400)", async () => {
      const res = await request(app)
        .post("/api/campaigns")
        .set("Content-Type", "application/json")
        .send('{"name": "Bad JSON", ');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe("ownership & 404 behavior", () => {
    let userACampaignId: string;

    beforeAll(async () => {
      const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      const csv = "email,first_name\nalice@example.com,Alice";

      const res = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "User A Campaign",
          subjectTemplate: "Hi {{first_name}}",
          bodyTemplate: "Body {{ai_intro}} {{unsubscribe_link}}",
          linkUrl: "https://example.com",
          unsubscribeUrl: "https://example.com/unsub",
          aiEnabled: true,
          scheduledAt,
          csv,
        });

      expect(res.status).toBe(201);
      userACampaignId = res.body.data.campaignId;
      createdCampaignIds.push(userACampaignId);
    });

    it("User B gets 404 identical to a nonexistent id on all /:id routes", async () => {
      const nonExistentId = "00000000-0000-0000-0000-000000000000";

      const routes = [
        { method: "get", path: "" },
        { method: "post", path: "/start" },
        { method: "post", path: "/samples/regenerate", body: {} },
        { method: "post", path: "/approve", body: {} },
        { method: "post", path: "/pause" },
        { method: "post", path: "/resume" },
        { method: "post", path: "/cancel" },
        { method: "get", path: "/drafts" },
        { method: "patch", path: "/drafts/draft-123", body: { type: "approve" } },
        { method: "post", path: "/drafts/bulk", body: { type: "approve" } },
      ];

      for (const route of routes) {
        const reqB = (request(app) as any)[route.method](`/api/campaigns/${userACampaignId}${route.path}`)
          .set("Authorization", `Bearer ${tokenUserB}`);
        if (route.body) reqB.send(route.body);
        const resB = await reqB;

        const reqNonexistent = (request(app) as any)[route.method](`/api/campaigns/${nonExistentId}${route.path}`)
          .set("Authorization", `Bearer ${tokenUserA}`);
        if (route.body) reqNonexistent.send(route.body);
        const resNonexistent = await reqNonexistent;

        expect(resB.status).toBe(404);
        expect(resNonexistent.status).toBe(404);
        expect(resB.body).toEqual({
          success: false,
          error: {
            code: "CAMPAIGN_NOT_FOUND",
            message: "Campaign not found",
          },
        });
        expect(resB.body).toEqual(resNonexistent.body);
      }
    });

    it("GET /api/campaigns invalid query -> 422 VALIDATION_FAILED with field path", async () => {
      const res = await request(app)
        .get("/api/campaigns?limit=999")
        .set("Authorization", `Bearer ${tokenUserA}`);

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
      const issues = res.body.error.details.issues;
      expect(issues.some((i: any) => i.path === "limit")).toBe(true);
    });

    it("GET /api/campaigns/:id/drafts invalid query -> 422 VALIDATION_FAILED with field path", async () => {
      const res = await request(app)
        .get(`/api/campaigns/${userACampaignId}/drafts?status=INVALID_STATUS`)
        .set("Authorization", `Bearer ${tokenUserA}`);

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
      const issues = res.body.error.details.issues;
      expect(issues.some((i: any) => i.path === "status")).toBe(true);
    });
  });

  describe("BUDGET_WARNING 409 and acknowledgement", () => {
    let budgetCampaignId: string;

    beforeAll(async () => {
      const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      const csv =
        "email,first_name,company\n" +
        "alice@example.com,Alice,Acme Inc\n" +
        "bob@example.com,Bob,Beta LLC\n" +
        "charlie@example.com,Charlie,Gamma Corp\n" +
        "david@example.com,David,Delta Co";

      const res = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "Budget Campaign",
          subjectTemplate: "Hi {{first_name}}",
          bodyTemplate: "Body {{ai_intro}} {{unsubscribe_link}}",
          linkUrl: "https://example.com",
          unsubscribeUrl: "https://example.com/unsub",
          aiEnabled: true,
          scheduledAt,
          csv,
        });

      expect(res.status).toBe(201);
      budgetCampaignId = res.body.data.campaignId;
      createdCampaignIds.push(budgetCampaignId);

      // Start sampling
      await request(app)
        .post(`/api/campaigns/${budgetCampaignId}/start`)
        .set("Authorization", `Bearer ${tokenUserA}`);

      // Drive campaign to SAMPLE_REVIEW through real flow instead of patching status
      const budgetLlm = new MockLlmClient({
        model: resolveModelName(config.ai),
        script: [
          { kind: "success", intro: "The engineering focus at your company stands out." },
          { kind: "success", intro: "Your recent expansion highlights great technical leadership." },
        ],
      });
      const budgetWorker = createGenerateWorker({ llm: budgetLlm });
      workers.push(budgetWorker);

      let reachedReview = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await executeCampaignTickRun();
        const camp = await prisma.campaign.findUnique({ where: { id: budgetCampaignId } });
        if (camp?.status === "SAMPLE_REVIEW") {
          reachedReview = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(reachedReview).toBe(true);
    });

    afterAll(async () => {
      await request(app)
        .post(`/api/campaigns/${budgetCampaignId}/cancel`)
        .set("Authorization", `Bearer ${tokenUserA}`)
        .catch(() => {});
    });

    it("returns 409 BUDGET_WARNING when needed > remaining without acknowledgement, 200 with acknowledgement", async () => {
      // Set daily rate limit so budget check is active
      const originalLimit = config.ai.dailyRateLimit;
      config.ai.dailyRateLimit = 10;

      // Mock runtime with 0 remaining calls
      setCampaignRuntimeForTesting({
        redis: {} as any,
        limiter: {} as any,
        getDailyUsage: async () => 10, // all 10 calls consumed
        close: async () => {},
      });

      try {
        const resWarning = await request(app)
          .post(`/api/campaigns/${budgetCampaignId}/approve`)
          .set("Authorization", `Bearer ${tokenUserA}`)
          .send({});

        expect(resWarning.status).toBe(409);
        expect(resWarning.body.success).toBe(false);
        expect(resWarning.body.error.code).toBe("BUDGET_WARNING");
        expect(resWarning.body.error.details).toHaveProperty("needed");
        expect(resWarning.body.error.details).toHaveProperty("remaining");

        // Approve with acknowledgeBudgetWarning: true -> succeeds
        const resApproved = await request(app)
          .post(`/api/campaigns/${budgetCampaignId}/approve`)
          .set("Authorization", `Bearer ${tokenUserA}`)
          .send({ acknowledgeBudgetWarning: true });

        expect(resApproved.status).toBe(200);
        expect(resApproved.body.success).toBe(true);
        expect(resApproved.body.data.status).toBe("GENERATING");
      } finally {
        config.ai.dailyRateLimit = originalLimit;
      }
    });
  });

  describe("lifecycle tests (Phase 7a)", () => {
    it("AI path: real generation, guardrail flags, resolution, scheduling and cancellation", async () => {
      const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      const csv =
        "email,first_name,company\n" +
        "alice@example.com,Alice,Acme Corp\n" +
        "bob@example.com,Bob,Beta LLC\n" +
        "charlie@example.com,Charlie,Gamma Inc\n" +
        "david@example.com,David,Delta Co\n" +
        "eve@example.com,Eve,Epsilon Ltd\n" +
        "frank@example.com,Frank,Zeta Group";

      // 1. Create campaign with 6 fake recipients (all with company data)
      const createRes = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "AI Lifecycle Campaign",
          subjectTemplate: "Hi {{first_name}}",
          bodyTemplate: "Intro: {{ai_intro}}. More info at {{link}}. Unsub: {{unsubscribe_link}}",
          linkUrl: "https://example.com/info",
          unsubscribeUrl: "https://example.com/unsub",
          aiEnabled: true,
          scheduledAt,
          csv,
        });

      expect(createRes.status).toBe(201);
      const campaignId = createRes.body.data.campaignId;
      createdCampaignIds.push(campaignId);

      // 2. Start campaign -> SAMPLING
      const startRes = await request(app)
        .post(`/api/campaigns/${campaignId}/start`)
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(startRes.status).toBe(200);
      expect(startRes.body.data.status).toBe("SAMPLING");

      // Injected MockLlmClient: first two calls clean (samples), next two flagged (greeting intros), remaining clean
      const mockLlm = new MockLlmClient({
        model: resolveModelName(config.ai),
        script: [
          { kind: "success", intro: "The engineering focus at your company stands out." },
          { kind: "success", intro: "Your recent expansion highlights great technical leadership." },
          { kind: "success", intro: "Hi there, hope all is well." },
          { kind: "success", intro: "Hello, hope your week is going well." },
          { kind: "success", intro: "The product updates from your team reflect impressive dedication." },
          { kind: "success", intro: "The work being done at your company is remarkable." },
        ],
      });

      const worker = createGenerateWorker({ llm: mockLlm });
      workers.push(worker);

      // Advance through tick helper -> SAMPLE_REVIEW
      let reachedSampleReview = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await executeCampaignTickRun();
        const camp = await prisma.campaign.findUnique({ where: { id: campaignId } });
        if (camp?.status === "SAMPLE_REVIEW") {
          reachedSampleReview = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(reachedSampleReview).toBe(true);

      // Approve -> moves to GENERATING
      const approveRes = await request(app)
        .post(`/api/campaigns/${campaignId}/approve`)
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({});
      expect(approveRes.status).toBe(200);
      expect(approveRes.body.data.status).toBe("GENERATING");

      // Advance through tick helper -> EXCEPTION_REVIEW
      let reachedExceptionReview = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await executeCampaignTickRun();
        const camp = await prisma.campaign.findUnique({ where: { id: campaignId } });
        if (camp?.status === "EXCEPTION_REVIEW") {
          reachedExceptionReview = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(reachedExceptionReview).toBe(true);

      // Through the API: list flagged drafts (assert exactly 2)
      const flaggedRes = await request(app)
        .get(`/api/campaigns/${campaignId}/drafts?status=FLAGGED`)
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(flaggedRes.status).toBe(200);
      expect(flaggedRes.body.data).toHaveLength(2);
      const [firstFlagged] = flaggedRes.body.data;

      // PATCH edit on the first with a clean sentence
      const editRes = await request(app)
        .patch(`/api/campaigns/${campaignId}/drafts/${firstFlagged.id}`)
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          type: "edit",
          aiIntro: "The ongoing technical innovation at your firm is remarkable.",
        });
      expect(editRes.status).toBe(200);
      expect(editRes.body.data.status).toBe("APPROVED");

      // Assert the campaign is STILL EXCEPTION_REVIEW because one flagged draft remains
      const campStillReview = await request(app)
        .get(`/api/campaigns/${campaignId}`)
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(campStillReview.status).toBe(200);
      expect(campStillReview.body.data.status).toBe("EXCEPTION_REVIEW");

      // POST bulk use_plain (assert changed 1)
      const bulkRes = await request(app)
        .post(`/api/campaigns/${campaignId}/drafts/bulk`)
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({ type: "use_plain" });
      expect(bulkRes.status).toBe(200);
      expect(bulkRes.body.data.changed).toBe(1);

      // Assert the campaign is SCHEDULED right after that call
      const campScheduled = await request(app)
        .get(`/api/campaigns/${campaignId}`)
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(campScheduled.status).toBe(200);
      expect(campScheduled.body.data.status).toBe("SCHEDULED");

      // And that one more tick run changes nothing
      await executeCampaignTickRun();
      const campStillScheduled = await request(app)
        .get(`/api/campaigns/${campaignId}`)
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(campStillScheduled.body.data.status).toBe("SCHEDULED");

      // Assert EmailJobs exist for every non-held draft
      const emailJobs = await prisma.emailJob.findMany({
        where: { generatedDraft: { campaignId } },
      });
      expect(emailJobs).toHaveLength(6);

      for (const job of emailJobs) {
        const qJob = await emailQueue.getJob(job.id);
        expect(qJob).not.toBeNull();
      }

      // Cancel from SCHEDULED and assert the EmailJobs and queue jobs are gone
      const cancelRes = await request(app)
        .post(`/api/campaigns/${campaignId}/cancel`)
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe("CANCELLED");

      const remainingJobs = await prisma.emailJob.findMany({
        where: { generatedDraft: { campaignId } },
      });
      expect(remainingJobs).toHaveLength(0);

      for (const job of emailJobs) {
        const qJob = await emailQueue.getJob(job.id);
        expect(qJob).toBeFalsy();
      }

      const drafts = await prisma.generatedDraft.findMany({ where: { campaignId } });
      expect(drafts.every((d) => d.status === "HELD")).toBe(true);
    });

    it("immediate progression: campaign with exactly one flagged draft moves straight to SCHEDULED on PATCH edit", async () => {
      const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      const csv =
        "email,first_name,company\n" +
        "u1@example.com,User1,Company One\n" +
        "u2@example.com,User2,Company Two\n" +
        "u3@example.com,User3,Company Three";

      // 1. Create with 3 recipients (2 samples, 1 remaining)
      const createRes = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "Immediate Progression Campaign",
          subjectTemplate: "Hello {{first_name}}",
          bodyTemplate: "Intro: {{ai_intro}}. Link: {{link}}. Unsub: {{unsubscribe_link}}",
          linkUrl: "https://example.com/info",
          unsubscribeUrl: "https://example.com/unsub",
          aiEnabled: true,
          scheduledAt,
          csv,
        });

      expect(createRes.status).toBe(201);
      const campaignId = createRes.body.data.campaignId;
      createdCampaignIds.push(campaignId);

      // Start -> SAMPLING
      await request(app)
        .post(`/api/campaigns/${campaignId}/start`)
        .set("Authorization", `Bearer ${tokenUserA}`);

      // First two calls clean (samples pass), third call flagged (greeting)
      const mockLlm = new MockLlmClient({
        model: resolveModelName(config.ai),
        script: [
          { kind: "success", intro: "The engineering focus at your company stands out." },
          { kind: "success", intro: "Your recent expansion highlights great technical leadership." },
          { kind: "success", intro: "Hi there, hope all is well." },
        ],
      });

      const worker = createGenerateWorker({ llm: mockLlm });
      workers.push(worker);

      // Advance to SAMPLE_REVIEW
      for (let attempt = 0; attempt < 30; attempt++) {
        await executeCampaignTickRun();
        const camp = await prisma.campaign.findUnique({ where: { id: campaignId } });
        if (camp?.status === "SAMPLE_REVIEW") break;
        await new Promise((r) => setTimeout(r, 200));
      }

      // Approve -> GENERATING
      await request(app)
        .post(`/api/campaigns/${campaignId}/approve`)
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({});

      // Advance to EXCEPTION_REVIEW
      for (let attempt = 0; attempt < 30; attempt++) {
        await executeCampaignTickRun();
        const camp = await prisma.campaign.findUnique({ where: { id: campaignId } });
        if (camp?.status === "EXCEPTION_REVIEW") break;
        await new Promise((r) => setTimeout(r, 200));
      }

      // List flagged drafts -> exactly 1
      const flaggedRes = await request(app)
        .get(`/api/campaigns/${campaignId}/drafts?status=FLAGGED`)
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(flaggedRes.body.data).toHaveLength(1);
      const flaggedDraft = flaggedRes.body.data[0];

      // PATCH edit moves it straight to SCHEDULED
      const editRes = await request(app)
        .patch(`/api/campaigns/${campaignId}/drafts/${flaggedDraft.id}`)
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          type: "edit",
          aiIntro: "The technical leadership at your company is remarkable.",
        });
      expect(editRes.status).toBe(200);
      expect(editRes.body.data.status).toBe("APPROVED");

      // Verify campaign is immediately SCHEDULED
      const campRes = await request(app)
        .get(`/api/campaigns/${campaignId}`)
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(campRes.body.data.status).toBe("SCHEDULED");

      // Clean up campaign and send jobs
      await request(app)
        .post(`/api/campaigns/${campaignId}/cancel`)
        .set("Authorization", `Bearer ${tokenUserA}`);
    });

    it("Plain path: create with aiEnabled false, start returns SCHEDULED with EmailJobs created, cancel cleans them up", async () => {
      const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      const csv =
        "email,first_name\n" +
        "p1@example.com,Plain1\n" +
        "p2@example.com,Plain2\n" +
        "p3@example.com,Plain3";

      // 1. Create with aiEnabled false
      const createRes = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "Plain Lifecycle Campaign",
          subjectTemplate: "Plain subject for {{first_name}}",
          bodyTemplate: "Plain body {{unsubscribe_link}}",
          linkUrl: "https://example.com/info",
          unsubscribeUrl: "https://example.com/unsub",
          aiEnabled: false,
          scheduledAt,
          csv,
        });

      expect(createRes.status).toBe(201);
      const campaignId = createRes.body.data.campaignId;
      createdCampaignIds.push(campaignId);

      // 2. Start returns SCHEDULED with EmailJobs created
      const startRes = await request(app)
        .post(`/api/campaigns/${campaignId}/start`)
        .set("Authorization", `Bearer ${tokenUserA}`);

      expect(startRes.status).toBe(200);
      expect(startRes.body.data.status).toBe("SCHEDULED");

      const emailJobs = await prisma.emailJob.findMany({
        where: { generatedDraft: { campaignId } },
      });
      expect(emailJobs).toHaveLength(3);

      for (const job of emailJobs) {
        const qJob = await emailQueue.getJob(job.id);
        expect(qJob).not.toBeNull();
      }

      // 3. Cancel cleans them up
      const cancelRes = await request(app)
        .post(`/api/campaigns/${campaignId}/cancel`)
        .set("Authorization", `Bearer ${tokenUserA}`);

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe("CANCELLED");

      const remainingJobs = await prisma.emailJob.findMany({
        where: { generatedDraft: { campaignId } },
      });
      expect(remainingJobs).toHaveLength(0);

      for (const job of emailJobs) {
        const qJob = await emailQueue.getJob(job.id);
        expect(qJob).toBeFalsy();
      }

      const drafts = await prisma.generatedDraft.findMany({ where: { campaignId } });
      expect(drafts.every((d) => d.status === "HELD")).toBe(true);
    });
  });

  describe("routes absent (404) when AI personalization is disabled", () => {
    it("returns 404 for /api/campaigns routes on the disabled app", async () => {
      const res = await request(appDisabled)
        .get("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`);

      expect(res.status).toBe(404);
    });
  });
});
