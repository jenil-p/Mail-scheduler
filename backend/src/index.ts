import express from "express";
import cors from "cors";
import type { Worker } from "bullmq";
import { config, isAiPersonalizationEnabled } from "./config";
import { errorHandler } from "./middleware/errorHandler";
import { createEmailWorker } from "./queue/worker";
import { recoverPendingJobs } from "./queue/recovery";
import { closeGenerateQueue } from "./queue/generateQueue";
import { createGenerateWorker } from "./queue/generateWorker";
import authRoutes from "./routes/auth";
import scheduleRoutes from "./routes/schedule";
import jobsRoutes from "./routes/jobs";

const app = express();

app.use(
  cors({
    origin: config.frontendUrl,
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    message: "Sendly API is running",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/schedule", scheduleRoutes);
app.use("/api/jobs", jobsRoutes);

app.use(errorHandler);

// Start the BullMQ worker to process email jobs from the queue
const worker = createEmailWorker();
console.log(`[Worker] Email processing worker started — queue: email-scheduler`);

// The generate worker only exists when AI personalization is enabled, so a
// deployment with the flag off runs exactly the processes it ran before.
const generateWorker: Worker | undefined = isAiPersonalizationEnabled()
  ? createGenerateWorker()
  : undefined;

if (generateWorker) {
  console.log(
    `[Generate] Generation worker started — queue: generate, provider: ${config.ai.provider}`
  );
} else {
  console.log("[Generate] AI personalization is disabled — no generation worker started");
}

// Campaign tick runs reconciliation and status progression when AI personalization is enabled
const stopCampaignTick: (() => void) | undefined = isAiPersonalizationEnabled()
  ? (await import("./campaigns/tick")).startCampaignTick({
      intervalMs: config.ai.campaignTickMs,
    })
  : undefined;

if (stopCampaignTick) {
  console.log(
    `[Tick] Campaign tick started — interval: ${config.ai.campaignTickMs}ms`
  );
}

// Recover pending jobs from DB that may have been lost from Redis
// Uses BullMQ's jobId dedup so it's safe to run even when Redis is healthy
recoverPendingJobs().then(({ recovered, skipped }) => {
  if (recovered > 0 || skipped > 0) {
    console.log(`[Startup] Recovery complete — ${recovered} re-queued, ${skipped} skipped`);
  }
}).catch((err) => {
  console.error(`[Startup] Recovery failed: ${err.message}`);
});

app.listen(config.port, () => {
  console.log(`server running on http://localhost:${config.port}`);
});

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("Shutting down gracefully...");
  stopCampaignTick?.();
  // Workers first (they finish the job in flight), then the queues they read from.
  await Promise.all([worker.close(), generateWorker?.close()]);
  await closeGenerateQueue();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);