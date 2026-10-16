/**
 * Jittered exponential backoff for the generate queue (decision A3).
 *
 * This is new code and is used **only** by the generate worker; the send queue
 * keeps its own declarative `backoff: { type: "exponential", delay: 5000 }`, which
 * must not change (NFR-2).
 *
 * BullMQ calls a custom `backoffStrategy(attemptsMade, type, error)` and expects
 * the delay in milliseconds. We use "equal jitter" — half the window fixed, half
 * random — so parallel retries spread out instead of stampeding, while the delay
 * still grows exponentially and stays under `maxMs`.
 */

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** 0 = no jitter, 1 = up to 100% spread. */
  jitterRatio: number;
  /** Injectable for deterministic tests. */
  random: () => number;
}

export const DEFAULT_BACKOFF_OPTIONS: BackoffOptions = {
  baseMs: 2_000,
  maxMs: 60_000,
  jitterRatio: 0.5,
  random: Math.random,
};

export function jitteredExponentialBackoff(
  attemptsMade: number,
  options: Partial<BackoffOptions> = {}
): number {
  const { baseMs, maxMs, jitterRatio, random } = { ...DEFAULT_BACKOFF_OPTIONS, ...options };

  const attempt = Math.max(1, Math.floor(attemptsMade));
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));

  const jitter = Math.min(Math.max(jitterRatio, 0), 1);
  const spread = 1 - jitter + random() * jitter;

  return Math.max(0, Math.round(exponential * spread));
}

/** BullMQ `BackoffStrategy` shape: (attemptsMade, type, error) => delay in ms. */
export function jitteredBackoffStrategy(
  attemptsMade: number,
  _type?: string,
  _error?: Error
): number {
  return jitteredExponentialBackoff(attemptsMade);
}

/**
 * The same strategy with the delays taken from configuration, which is what the
 * generate worker passes to BullMQ as `settings.backoffStrategy`. `maxMs` only
 * caps the window: the jitter still varies every retry.
 */
export function createJitteredBackoffStrategy(
  options: Pick<BackoffOptions, "baseMs" | "maxMs"> & Partial<BackoffOptions>
): (attemptsMade: number, type?: string, error?: Error) => number {
  return (attemptsMade: number) => jitteredExponentialBackoff(attemptsMade, options);
}
