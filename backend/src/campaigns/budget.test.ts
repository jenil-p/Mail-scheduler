import { describe, expect, it, vi } from "vitest";
import { createDailyUsageGetter, type DailyUsageLimiter } from "./budget";

describe("createDailyUsageGetter", () => {
  it("delegates to limiter.dailyUsage with provider and passed model", async () => {
    const limiter: DailyUsageLimiter = {
      dailyUsage: vi.fn().mockResolvedValue(42),
    };

    const getter = createDailyUsageGetter(limiter, "gemini");
    const usage = await getter("gemini-2.5-flash");

    expect(usage).toBe(42);
    expect(limiter.dailyUsage).toHaveBeenCalledWith("gemini", "gemini-2.5-flash");
  });
});
