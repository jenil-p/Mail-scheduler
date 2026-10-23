/**
 * Campaign runtime dependencies (Phase 7a).
 *
 * Lazily builds and caches the shared pieces the API needs:
 * - A Redis connection
 * - An LlmLimiter configured with the same options `createGenerateWorker` uses
 * - `getDailyUsage = createDailyUsageGetter(limiter, ai.provider)`
 *
 * Closed during graceful shutdown.
 */

import Redis from "ioredis";
import { config } from "../config";
import { LlmLimiter } from "../ai/rateLimit/llmLimiter";
import { createDailyUsageGetter } from "./budget";

export interface CampaignRuntime {
  redis: Redis;
  limiter: LlmLimiter;
  getDailyUsage: (model: string) => Promise<number>;
  close: () => Promise<void>;
}

let cachedRuntime: CampaignRuntime | null = null;

export function getCampaignRuntime(): CampaignRuntime {
  if (cachedRuntime) {
    return cachedRuntime;
  }

  const ai = config.ai;
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: null,
  });

  const limiter = new LlmLimiter(redis, {
    perMinute: ai.rateLimitPerMin,
    dailyLimit: ai.dailyRateLimit,
    resetTimeZone: ai.dailyResetTz,
  });

  const getDailyUsage = createDailyUsageGetter(limiter, ai.provider);

  cachedRuntime = {
    redis,
    limiter,
    getDailyUsage,
    close: async () => {
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    },
  };

  return cachedRuntime;
}

export async function closeCampaignRuntime(): Promise<void> {
  if (cachedRuntime) {
    const runtime = cachedRuntime;
    cachedRuntime = null;
    await runtime.close();
  }
}

/** Injects a test runtime or clears the cache (for testing only). */
export function setCampaignRuntimeForTesting(runtime: CampaignRuntime | null): void {
  cachedRuntime = runtime;
}
