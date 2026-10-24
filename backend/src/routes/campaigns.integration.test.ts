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

    it("blocking problem: reviewMode FULL too large -> 422 with FULL_REVIEW_TOO_LARGE", async () => {
      const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      const maxFull = config.ai.fullReviewMaxRecipients;
      const rows = ["email"];
      for (let i = 0; i < maxFull + 2; i++) {
        rows.push(`user${i}@example.com`);
      }
      const csv = rows.join("\n");

      const res = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "Full Review Too Large",
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
      expect(res.body.error.code).toBe("FULL_REVIEW_TOO_LARGE");
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

      const res = await request(app)
        .post("/api/campaigns")
        .send({
          name: "Huge Payload",
          bodyTemplate: hugeString,
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
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
  });

  describe("BUDGET_WARNING 409 and acknowledgement", () => {
    let budgetCampaignId: string;

    beforeAll(async () => {
      const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      const csv =
        "email,first_name,company\n" +
        "alice@example.com,Alice,Acme\n" +
        "bob@example.com,Bob,Beta\n" +
        "charlie@example.com,Charlie,Gamma\n" +
        "david@example.com,David,Delta";

      const res = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "Budget Campaign",
          subjectTemplate: "Hi",
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

      // Transition campaign to SAMPLE_REVIEW manually for testing approveSamples
      await prisma.campaign.update({
        where: { id: budgetCampaignId },
        data: { status: "SAMPLE_REVIEW" },
      });
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

  describe("full lifecycle through API with fake example.com recipients", () => {
    it("runs complete lifecycle: create -> start -> worker + tick -> SAMPLE_REVIEW -> approve -> tick -> EXCEPTION_REVIEW / SCHEDULED -> draft edits & resolution -> pause/resume/cancel", async () => {
      const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      const csv =
        "email,first_name,company\n" +
        "r1@example.com,R1,Alpha\n" +
        "r2@example.com,R2,Beta\n" +
        "r3@example.com,R3,Gamma\n" +
        "r4@example.com,R4,Delta";

      // 1. Create
      const createRes = await request(app)
        .post("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({
          name: "Lifecycle Campaign",
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

      // Verify GET /api/campaigns contains this campaign
      const listRes = await request(app)
        .get("/api/campaigns")
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.some((c: any) => c.id === campaignId)).toBe(true);

      // Verify GET /api/campaigns/:id
      const getRes = await request(app)
        .get(`/api/campaigns/${campaignId}`)
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.status).toBe("DRAFT");
      expect(getRes.body.data.recipientCount).toBe(4);

      // 2. Start sampling
      const startRes = await request(app)
        .post(`/api/campaigns/${campaignId}/start`)
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(startRes.status).toBe(200);
      expect(startRes.body.data.status).toBe("SAMPLING");

      // Start the real generate worker to process sample jobs
      const worker = createGenerateWorker();
      workers.push(worker);

      // Wait for sample jobs to complete and tick to advance status
      let statusAfterSampling = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        await executeCampaignTickRun();
        const check = await prisma.campaign.findUnique({ where: { id: campaignId } });
        if (check?.status === "SAMPLE_REVIEW") {
          statusAfterSampling = "SAMPLE_REVIEW";
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(statusAfterSampling).toBe("SAMPLE_REVIEW");

      // Verify list drafts returns samples
      const draftsRes = await request(app)
        .get(`/api/campaigns/${campaignId}/drafts?isSample=true`)
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(draftsRes.status).toBe(200);
      expect(draftsRes.body.data.length).toBeGreaterThan(0);

      // 3. Test regenerateSamples
      const regenRes = await request(app)
        .post(`/api/campaigns/${campaignId}/samples/regenerate`)
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({ aiInstruction: "Warm and direct" });
      expect(regenRes.status).toBe(200);
      expect(regenRes.body.data.status).toBe("SAMPLING");

      // Wait again for worker + tick to advance to SAMPLE_REVIEW
      for (let attempt = 0; attempt < 30; attempt++) {
        await executeCampaignTickRun();
        const check = await prisma.campaign.findUnique({ where: { id: campaignId } });
        if (check?.status === "SAMPLE_REVIEW") break;
        await new Promise((r) => setTimeout(r, 200));
      }

      // 4. Approve samples -> moves to GENERATING
      const approveRes = await request(app)
        .post(`/api/campaigns/${campaignId}/approve`)
        .set("Authorization", `Bearer ${tokenUserA}`)
        .send({});
      expect(approveRes.status).toBe(200);
      expect(approveRes.body.data.status).toBe("GENERATING");

      // Wait for remaining generation and tick run
      for (let attempt = 0; attempt < 30; attempt++) {
        await executeCampaignTickRun();
        const check = await prisma.campaign.findUnique({ where: { id: campaignId } });
        if (check?.status === "EXCEPTION_REVIEW" || check?.status === "SCHEDULED") break;
        await new Promise((r) => setTimeout(r, 200));
      }

      // 5. Test draft resolution endpoints in EXCEPTION_REVIEW
      // Put campaign in EXCEPTION_REVIEW with a flagged draft to test draft endpoints
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: "EXCEPTION_REVIEW" },
      });

      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      const testDraft = await prisma.generatedDraft.findFirst({
        where: { campaignId, promptVersion: campaign.promptFingerprint! },
      });
      expect(testDraft).toBeDefined();

      if (testDraft) {
        // Mark draft FLAGGED with non-hard-blocked code
        await prisma.generatedDraft.update({
          where: { id: testDraft.id },
          data: { status: "FLAGGED", flagReasons: [{ code: "ROBOTIC_PHRASE", detail: "robotic" }] },
        });

        // Test PATCH edit
        const editRes = await request(app)
          .patch(`/api/campaigns/${campaignId}/drafts/${testDraft.id}`)
          .set("Authorization", `Bearer ${tokenUserA}`)
          .send({ type: "edit", aiIntro: "Edited intro text" });
        expect(editRes.status).toBe(200);
        expect(editRes.body.data.status).toBe("APPROVED");

        // Mark FLAGGED with hard-blocked code and verify 409 HARD_BLOCKED on approve
        await prisma.generatedDraft.update({
          where: { id: testDraft.id },
          data: { status: "FLAGGED", flagReasons: [{ code: "FORBIDDEN_CONTENT", detail: "blocked" }] },
        });

        const blockedRes = await request(app)
          .patch(`/api/campaigns/${campaignId}/drafts/${testDraft.id}`)
          .set("Authorization", `Bearer ${tokenUserA}`)
          .send({ type: "approve" });
        expect(blockedRes.status).toBe(409);
        expect(blockedRes.body.error.code).toBe("HARD_BLOCKED");

        // Test use_plain on hard-blocked draft (fallback succeeds)
        const plainRes = await request(app)
          .patch(`/api/campaigns/${campaignId}/drafts/${testDraft.id}`)
          .set("Authorization", `Bearer ${tokenUserA}`)
          .send({ type: "use_plain" });
        expect(plainRes.status).toBe(200);
        expect(plainRes.body.data.status).toBe("FALLBACK");

        // Test bulkResolve
        await prisma.generatedDraft.update({
          where: { id: testDraft.id },
          data: { status: "FLAGGED", flagReasons: [{ code: "GENERIC_INTRO", detail: "generic" }] },
        });

        const bulkRes = await request(app)
          .post(`/api/campaigns/${campaignId}/drafts/bulk`)
          .set("Authorization", `Bearer ${tokenUserA}`)
          .send({ type: "approve", codes: ["GENERIC_INTRO"] });
        expect(bulkRes.status).toBe(200);
        expect(bulkRes.body.data.changed).toBe(1);
      }

      // 6. Test pause / resume / cancel
      const pauseRes = await request(app)
        .post(`/api/campaigns/${campaignId}/pause`)
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(pauseRes.status).toBe(200);
      expect(pauseRes.body.data.status).toBe("PAUSED");

      const resumeRes = await request(app)
        .post(`/api/campaigns/${campaignId}/resume`)
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(resumeRes.status).toBe(200);

      const cancelRes = await request(app)
        .post(`/api/campaigns/${campaignId}/cancel`)
        .set("Authorization", `Bearer ${tokenUserA}`);
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe("CANCELLED");
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
