import { describe, it, expect } from "vitest";
import { nextPollDelayMs } from "./campaignPolling";

describe("campaignPolling", () => {
  describe("nextPollDelayMs", () => {
    it("returns 5000ms when tab is visible and there is no poll error", () => {
      const delay = nextPollDelayMs({ hidden: false, hadError: false });
      expect(delay).toBe(5000);
    });

    it("returns 15000ms when tab is hidden", () => {
      const delay = nextPollDelayMs({ hidden: true, hadError: false });
      expect(delay).toBe(15000);
    });

    it("returns 15000ms when a previous poll encountered an error", () => {
      const delay = nextPollDelayMs({ hidden: false, hadError: true });
      expect(delay).toBe(15000);
    });

    it("returns 15000ms when tab is hidden and there is an error", () => {
      const delay = nextPollDelayMs({ hidden: true, hadError: true });
      expect(delay).toBe(15000);
    });
  });
});
