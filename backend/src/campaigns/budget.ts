/**
 * Daily usage source for campaign sample approval (Phase 5a / Phase 7).
 */

export interface DailyUsageLimiter {
  dailyUsage(provider: string, model: string): Promise<number>;
}

/**
 * Creates a daily usage getter function that queries the given limiter for today's usage.
 * Passed to `approveSamples` via `getDailyUsage`.
 */
export function createDailyUsageGetter(
  limiter: DailyUsageLimiter,
  provider: string
): (model: string) => Promise<number> {
  return (model: string) => limiter.dailyUsage(provider, model);
}
