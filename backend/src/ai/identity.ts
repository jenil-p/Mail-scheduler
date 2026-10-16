/**
 * Deterministic identity (spec section 6.4).
 *
 *   promptFingerprint = sha256(PROMPT_VERSION|aiInstruction|modelId).hex[0..16]
 *   draftId           = sha256(campaignId|recipientId|templateHash|promptFingerprint).hex[0..32]
 *
 * Both are hex only, because BullMQ rejects some separators in custom job ids.
 *
 * The identity is always built from the campaign's **stored** prompt identity
 * (`promptFingerprint` / `llmModel` / `promptTemplateVersion`), never from live
 * env: a campaign that was frozen under one prompt keeps generating with it, and
 * the worker refuses to generate when the running code's PROMPT_VERSION no longer
 * matches what the campaign was frozen with.
 */

import { createHash } from "node:crypto";

export const PROMPT_FINGERPRINT_LENGTH = 16;
export const DRAFT_ID_LENGTH = 32;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface PromptIdentityInput {
  /** The prompt template version the campaign was frozen with. */
  promptTemplateVersion: string;
  aiInstruction: string;
  llmModel: string;
}

export function promptFingerprint(input: PromptIdentityInput): string {
  return sha256(
    `${input.promptTemplateVersion}|${input.aiInstruction}|${input.llmModel}`
  ).slice(0, PROMPT_FINGERPRINT_LENGTH);
}

export interface DraftIdentityInput {
  campaignId: string;
  recipientId: string;
  templateHash: string;
  promptFingerprint: string;
}

export function draftId(input: DraftIdentityInput): string {
  return sha256(
    `${input.campaignId}|${input.recipientId}|${input.templateHash}|${input.promptFingerprint}`
  ).slice(0, DRAFT_ID_LENGTH);
}

/** The prompt identity a campaign was frozen with (all three are required). */
export interface CampaignPromptIdentity {
  promptFingerprint: string;
  llmModel: string;
  promptTemplateVersion: string;
}

export class CampaignPromptIdentityMissingError extends Error {
  constructor(campaignId: string) {
    super(
      `Campaign ${campaignId} has no frozen prompt identity (promptFingerprint / llmModel / promptTemplateVersion). ` +
        "Sampling was never started for it."
    );
    this.name = "CampaignPromptIdentityMissingError";
  }
}

export function campaignPromptIdentity(campaign: {
  id: string;
  promptFingerprint?: string | null;
  llmModel?: string | null;
  promptTemplateVersion?: string | null;
}): CampaignPromptIdentity {
  const { promptFingerprint: fingerprint, llmModel, promptTemplateVersion } = campaign;

  if (!fingerprint || !llmModel || !promptTemplateVersion) {
    throw new CampaignPromptIdentityMissingError(campaign.id);
  }

  return { promptFingerprint: fingerprint, llmModel, promptTemplateVersion };
}
