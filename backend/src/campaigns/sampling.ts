/**
 * Deterministic sample selection for campaigns (spec section 3, FR-4, Phase 5a).
 *
 * "Personalization fields" means company, role and note only (first_name does not count).
 *
 * Preference order:
 * (a) the recipients with the most non-empty personalization fields, up to ceil(sampleSize / 2);
 * (b) one thin-data recipient if any exists;
 * (c) the recipient with the longest company name;
 * then fill up to sampleSize from the remaining data-rich recipients;
 * no duplicates; ties broken by recipient id.
 */

export interface SampleRecipientCandidate {
  id: string;
  company?: string | null;
  role?: string | null;
  note?: string | null;
  firstName?: string | null;
  [key: string]: unknown;
}

/**
 * Count the non-empty personalization fields for a recipient.
 * Only company, role and note count (first_name does not count).
 */
export function countPersonalizationFields(recipient: SampleRecipientCandidate): number {
  let count = 0;
  if (typeof recipient.company === "string" && recipient.company.trim().length > 0) {
    count++;
  }
  if (typeof recipient.role === "string" && recipient.role.trim().length > 0) {
    count++;
  }
  if (typeof recipient.note === "string" && recipient.note.trim().length > 0) {
    count++;
  }
  return count;
}

/**
 * Return trimmed length of company name, or 0 if missing/whitespace.
 */
export function getCompanyLength(recipient: SampleRecipientCandidate): number {
  if (typeof recipient.company === "string") {
    return recipient.company.trim().length;
  }
  return 0;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Select up to `sampleSize` sample recipients following the preference rules.
 * Pure and deterministic.
 */
export function selectSampleRecipients<T extends SampleRecipientCandidate>(
  recipients: readonly T[],
  sampleSize: number
): T[] {
  if (sampleSize <= 0 || recipients.length === 0) {
    return [];
  }

  const selected: T[] = [];
  const selectedIds = new Set<string>();

  const add = (candidate: T): boolean => {
    if (selectedIds.has(candidate.id) || selected.length >= sampleSize) {
      return false;
    }
    selected.push(candidate);
    selectedIds.add(candidate.id);
    return true;
  };

  // (a) the recipients with the most non-empty personalization fields, up to ceil(sampleSize / 2)
  const dataRich = recipients
    .filter((r) => countPersonalizationFields(r) > 0)
    .sort((a, b) => {
      const countDiff = countPersonalizationFields(b) - countPersonalizationFields(a);
      if (countDiff !== 0) return countDiff;
      return compareIds(a.id, b.id);
    });

  const maxFromA = Math.ceil(sampleSize / 2);
  for (const candidate of dataRich) {
    if (selected.length >= maxFromA || selected.length >= sampleSize) {
      break;
    }
    add(candidate);
  }

  // (b) one thin-data recipient if any exists
  if (selected.length < sampleSize) {
    const thinCandidates = recipients
      .filter((r) => countPersonalizationFields(r) === 0)
      .sort((a, b) => compareIds(a.id, b.id));

    if (thinCandidates.length > 0) {
      add(thinCandidates[0]);
    }
  }

  // (c) the recipient with the longest company name
  if (selected.length < sampleSize) {
    const companyCandidates = recipients
      .filter((r) => getCompanyLength(r) > 0)
      .sort((a, b) => {
        const lenDiff = getCompanyLength(b) - getCompanyLength(a);
        if (lenDiff !== 0) return lenDiff;
        return compareIds(a.id, b.id);
      });

    if (companyCandidates.length > 0) {
      // If the top candidate was already selected in (a), add() no-ops and we proceed to fill
      add(companyCandidates[0]);
    }
  }

  // then fill up to sampleSize from the remaining data-rich recipients; no duplicates; ties broken by recipient id.
  if (selected.length < sampleSize) {
    for (const candidate of dataRich) {
      if (selected.length >= sampleSize) {
        break;
      }
      add(candidate);
    }
  }

  return selected;
}
