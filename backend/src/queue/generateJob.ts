/**
 * The payload of one `generate` job.
 *
 * It carries ids only — never an email address, never a rendered template, never
 * prompt text. Everything the worker needs is read from the database by id, which
 * keeps free-text recipient data out of Redis and out of BullMQ's job logs (NFR-4).
 */

export interface GenerateJobData {
  /** Deterministic draft id; also the BullMQ job id. */
  draftId: string;
  campaignId: string;
  recipientId: string;
  /** True for the Phase 5 sample drafts. */
  isSample: boolean;
}

/**
 * Narrow a job payload that came from Redis. A job written by an older/newer
 * version of the code must not reach the processor as a half-shaped object.
 */
export function isGenerateJobData(value: unknown): value is GenerateJobData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;

  return (
    typeof data.draftId === "string" &&
    data.draftId.length > 0 &&
    typeof data.campaignId === "string" &&
    data.campaignId.length > 0 &&
    typeof data.recipientId === "string" &&
    data.recipientId.length > 0 &&
    typeof data.isSample === "boolean"
  );
}
