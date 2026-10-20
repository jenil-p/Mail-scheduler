import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { config } from "../config";
import type { PrismaClient } from "../generated/prisma/client";
import scheduleRoutes from "./schedule";
import { emailQueue } from "../queue/queue";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testRedisHost = process.env.TEST_REDIS_HOST;
const testRedisPort = process.env.TEST_REDIS_PORT;

const suite = testDatabaseUrl && testRedisHost && testRedisPort ? describe : describe.skip;

suite("POST /api/schedule path (integration)", () => {
  let prisma: PrismaClient;
  const createdJobIds: string[] = [];
  const testEmail = "scheduler-tester@example.com";
  let token: string;

  const app = express();
  app.use(express.json());
  app.use("/api/schedule", scheduleRoutes);

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.REDIS_HOST = testRedisHost;
    process.env.REDIS_PORT = testRedisPort;

    const { prisma: client } = await import("../db/pool");
    prisma = client;

    token = jwt.sign(
      { email: testEmail, name: "Schedule Tester", id: "tester-id" },
      config.jwt.secret,
      { expiresIn: "1h" }
    );
  });

  afterAll(async () => {
    if (createdJobIds.length > 0) {
      for (const id of createdJobIds) {
        const job = await emailQueue.getJob(id);
        await job?.remove();
      }
      await prisma.emailJob.deleteMany({ where: { id: { in: createdJobIds } } });
    }
    await prisma.$disconnect();
  });

  it("schedules an email job via the existing send path unchanged", async () => {
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    const payload = {
      recipients: ["recipient-existing@example.com"],
      subject: "Hello from Existing Path",
      body: "<p>Original Body</p>",
      senderEmail: "Sendly Scheduler <scheduler@sendly.local>",
      scheduledAt,
      delayBetweenEmails: 2000,
    };

    const res = await request(app)
      .post("/api/schedule")
      .set("Authorization", `Bearer ${token}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total).toBe(1);

    const createdJob = res.body.data.jobs[0];
    expect(createdJob.id).toBeTruthy();
    createdJobIds.push(createdJob.id);

    // Verify DB record
    const dbJob = await prisma.emailJob.findUnique({ where: { id: createdJob.id } });
    expect(dbJob).toBeDefined();
    expect(dbJob?.userId).toBe(testEmail);
    expect(dbJob?.recipientEmail).toBe("recipient-existing@example.com");
    expect(dbJob?.subject).toBe("Hello from Existing Path");
    expect(dbJob?.body).toBe("<p>Original Body</p>");
    expect(dbJob?.senderEmail).toBe("Sendly Scheduler <scheduler@sendly.local>");
    expect(dbJob?.status).toBe("pending");

    // Verify BullMQ queue
    const queueJob = await emailQueue.getJob(createdJob.id);
    expect(queueJob).toBeDefined();
    expect(queueJob?.data).toMatchObject({
      jobId: createdJob.id,
      recipientEmail: "recipient-existing@example.com",
      subject: "Hello from Existing Path",
      body: "<p>Original Body</p>",
      senderEmail: "Sendly Scheduler <scheduler@sendly.local>",
    });
  });
});
