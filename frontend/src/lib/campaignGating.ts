import { CreateCampaignPayload, DryRunResponseData } from "@/types/campaigns";

export interface CampaignFormState {
  name: string;
  subjectTemplate: string;
  bodyTemplate: string;
  linkUrl: string;
  unsubscribeUrl: string;
  aiEnabled: boolean;
  aiInstruction: string;
  onUnresolved: "FALLBACK_TO_PLAIN" | "HOLD";
  scheduledAt: string;
  csv: string;
}

/**
 * Serializes form state into a stable fingerprint string to detect any edits.
 */
export function getFormFingerprint(form: CampaignFormState): string {
  return JSON.stringify({
    name: form.name.trim(),
    subjectTemplate: form.subjectTemplate,
    bodyTemplate: form.bodyTemplate,
    linkUrl: form.linkUrl.trim(),
    unsubscribeUrl: form.unsubscribeUrl.trim(),
    aiEnabled: form.aiEnabled,
    aiInstruction: form.aiEnabled ? form.aiInstruction.trim() : "",
    onUnresolved: form.onUnresolved,
    scheduledAt: form.scheduledAt.trim(),
    csvLength: form.csv.length,
    // Include CSV content snippet or full string for exact fingerprinting
    csv: form.csv,
  });
}

/**
 * Pure function to determine if the form values have changed since the last dry run.
 */
export function isDryRunValidForCurrentForm(
  validatedFingerprint: string | null,
  currentForm: CampaignFormState
): boolean {
  if (!validatedFingerprint) return false;
  return validatedFingerprint === getFormFingerprint(currentForm);
}

/**
 * Evaluates whether the "Create campaign" button should be enabled.
 * It is enabled ONLY when:
 * 1. A dry run was performed on the EXACT current form values.
 * 2. The dry run returned zero blocking errors.
 * 3. The form is not currently validating or submitting.
 */
export function canCreateCampaign(params: {
  validatedFingerprint: string | null;
  currentForm: CampaignFormState;
  dryRunResult: DryRunResponseData | null;
  isValidating: boolean;
  isCreating: boolean;
}): boolean {
  const { validatedFingerprint, currentForm, dryRunResult, isValidating, isCreating } = params;

  if (isValidating || isCreating) return false;
  if (!dryRunResult) return false;
  if (!isDryRunValidForCurrentForm(validatedFingerprint, currentForm)) return false;
  if (dryRunResult.errors && dryRunResult.errors.length > 0) return false;

  return true;
}

/**
 * Validates file size before reading/sending. Returns true if file is <= 1 MB (1048576 bytes).
 */
export const MAX_CSV_SIZE_BYTES = 1024 * 1024; // 1 MB

export function isCsvFileWithinLimit(fileSizeBytes: number): boolean {
  return fileSizeBytes <= MAX_CSV_SIZE_BYTES;
}
