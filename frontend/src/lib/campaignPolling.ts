export interface PollDelayOptions {
  hidden: boolean;
  hadError: boolean;
}

/**
 * Calculates the next polling delay in milliseconds based on tab visibility and error state.
 * Returns 15000ms (15s) when the tab is hidden or a previous poll encountered an error,
 * otherwise returns 5000ms (5s).
 */
export function nextPollDelayMs({ hidden, hadError }: PollDelayOptions): number {
  return hidden || hadError ? 15000 : 5000;
}
