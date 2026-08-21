import express from "express";
import cors from "cors";
import { config } from "./config";
import { errorHandler } from "./middleware/errorHandler";
import { createEmailWorker } from "./queue/worker";
import { recoverPendingJobs } from "./queue/recovery";
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
process.on("SIGTERM", async () => {
  console.log("Shutting down gracefully...");
  await worker.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("Shutting down gracefully...");
  await worker.close();
  process.exit(0);
});