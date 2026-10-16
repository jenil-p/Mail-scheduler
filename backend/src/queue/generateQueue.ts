/**
 * The `generate` queue (spec FR-5): generation is completely separate from the
 * send queue, so LLM latency can never hold up sends (NFR-1).
 *
 * The queue is created **lazily** and only ever touched when AI personalization
 * is enabled, so a deployment that has the feature off does not open a queue
 * that did not exist before (NFR-2). It shares the send queue's Redis connection,
 * which is already configured with `maxRetriesPerRequest: null` as BullMQ needs.
 *
 * Job identity is the draft id (spec 6.4), which is what makes `enqueueGenerate`
 * idempotent: adding a job whose id is already in the queue is a no-op, and the
 * worker re-checks the draft's status anyway (FR-7).
 */

import { Queue, type JobsOptions } from "bullmq";
import { config } from "../config";
import { redisConnection } from "./queue";
import type { GenerateJobData } from "./generateJob";

export const GENERATE_QUEUE_NAME = "generate";
export const GENERATE_JOB_NAME = "generate-draft";

let generateQueue: Queue<GenerateJobData> | undefined;

function createGenerateQueue(): Queue<GenerateJobData> {
  return new Queue<GenerateJobData>(GENERATE_QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: generateJobOptions(),
  });
}

/**
 * Job options for one draft. `attempts` is `1 + LLM_MAX_RETRIES` (decision A3) and
 * the delay for each retry comes from the worker's custom `backoffStrategy`, which
 * is why the type here is `custom`.
 */
export function generateJobOptions(attempts = 1 + config.ai.maxRetries): JobsOptions {
  return {
    attempts,
    backoff: { type: "custom" },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  };
}

export function getGenerateQueue(): Queue<GenerateJobData> {
  generateQueue ??= createGenerateQueue();
  return generateQueue;
}

/** Close the queue's connection; safe to call when it was never created. */
export async function closeGenerateQueue(): Promise<void> {
  if (!generateQueue) return;
  await generateQueue.close();
  generateQueue = undefined;
}
