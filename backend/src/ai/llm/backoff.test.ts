import { describe, expect, it } from "vitest";
import {
  createJitteredBackoffStrategy,
  DEFAULT_BACKOFF_OPTIONS,
  jitteredBackoffStrategy,
  jitteredExponentialBackoff,
} from "./backoff";

describe("jitteredExponentialBackoff", () => {
  it("grows exponentially and is deterministic when the randomness is fixed", () => {
    const options = { baseMs: 1_000, maxMs: 60_000, jitterRatio: 0, random: () => 0 };

    expect(jitteredExponentialBackoff(1, options)).toBe(1_000);
    expect(jitteredExponentialBackoff(2, options)).toBe(2_000);
    expect(jitteredExponentialBackoff(3, options)).toBe(4_000);
    expect(jitteredExponentialBackoff(4, options)).toBe(8_000);
  });

  it("caps the delay at maxMs even after many attempts", () => {
    const options = { baseMs: 1_000, maxMs: 5_000, jitterRatio: 0, random: () => 1 };

    expect(jitteredExponentialBackoff(20, options)).toBe(5_000);
  });

  it("spreads retries inside the window instead of firing together", () => {
    const base = { baseMs: 1_000, maxMs: 60_000, jitterRatio: 0.5 };
    const lower = jitteredExponentialBackoff(2, { ...base, random: () => 0 });
    const upper = jitteredExponentialBackoff(2, { ...base, random: () => 1 });

    // Equal jitter: half the window fixed, half random.
    expect(lower).toBe(1_000);
    expect(upper).toBe(2_000);
    expect(lower).toBeLessThan(upper);
  });

  it("never returns a negative delay for attempt numbers below 1", () => {
    expect(jitteredExponentialBackoff(0, { random: () => 0 })).toBeGreaterThanOrEqual(0);
    expect(jitteredExponentialBackoff(-5, { random: () => 0 })).toBeGreaterThanOrEqual(0);
  });

  it("defaults are in the documented ballpark and clamp out-of-range jitter", () => {
    expect(DEFAULT_BACKOFF_OPTIONS.baseMs).toBe(2_000);
    expect(DEFAULT_BACKOFF_OPTIONS.maxMs).toBe(60_000);

    const options = { baseMs: 1_000, maxMs: 10_000, jitterRatio: 5, random: () => 1 };
    expect(jitteredExponentialBackoff(2, options)).toBe(2_000); // clamped to a ratio of 1
  });

  it("exposes a BullMQ-shaped strategy that honours the default window", () => {
    const exponential = DEFAULT_BACKOFF_OPTIONS.baseMs * 2 ** 2; // 2000 * 4 for attempt 3
    const delay = jitteredBackoffStrategy(3, "custom", new Error("boom"));

    // Equal jitter: between half the window and the whole window.
    expect(delay).toBeGreaterThanOrEqual(exponential * (1 - DEFAULT_BACKOFF_OPTIONS.jitterRatio));
    expect(delay).toBeLessThanOrEqual(exponential);
  });
});

describe("createJitteredBackoffStrategy", () => {
  it("takes its delays from the given config and still jitters per call", () => {
    const strategy = createJitteredBackoffStrategy({ baseMs: 100, maxMs: 400, jitterRatio: 1 });

    const delays = Array.from({ length: 40 }, () => strategy(2));

    expect(Math.min(...delays)).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(200);
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it("keeps the delay under the configured ceiling", () => {
    const strategy = createJitteredBackoffStrategy({ baseMs: 10, maxMs: 50, jitterRatio: 0.5 });

    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(strategy(attempt)).toBeLessThanOrEqual(50);
    }
  });
});
