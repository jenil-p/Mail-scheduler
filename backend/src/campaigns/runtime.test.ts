import { describe, expect, it, vi, afterEach } from "vitest";
import {
  getCampaignRuntime,
  closeCampaignRuntime,
  setCampaignRuntimeForTesting,
  type CampaignRuntime,
} from "./runtime";

describe("runtime (Phase 7a)", () => {
  afterEach(async () => {
    await closeCampaignRuntime();
    setCampaignRuntimeForTesting(null);
  });

  it("lazily builds and caches the runtime instance", async () => {
    const runtime1 = getCampaignRuntime();
    const runtime2 = getCampaignRuntime();

    expect(runtime1).toBe(runtime2);
    expect(runtime1.redis).toBeDefined();
    expect(runtime1.limiter).toBeDefined();
    expect(typeof runtime1.getDailyUsage).toBe("function");
    expect(typeof runtime1.close).toBe("function");
  });

  it("allows setting and closing a test runtime", async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const mockRuntime: CampaignRuntime = {
      redis: {} as any,
      limiter: {
        dailyUsage: vi.fn().mockResolvedValue(42),
      } as any,
      getDailyUsage: async (model: string) => 42,
      close: closeSpy,
    };

    setCampaignRuntimeForTesting(mockRuntime);
    expect(getCampaignRuntime()).toBe(mockRuntime);

    const usage = await getCampaignRuntime().getDailyUsage("test-model");
    expect(usage).toBe(42);

    await closeCampaignRuntime();
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // After closing, cache is cleared so next call builds a fresh instance
    const fresh = getCampaignRuntime();
    expect(fresh).not.toBe(mockRuntime);
  });
});
