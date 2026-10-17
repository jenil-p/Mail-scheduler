import type { GuardrailFailure, GuardrailRecipientData } from "./types";

/**
 * UNGROUNDED_NUMBER: any digit sequence in the intro that does not appear as a substring
 * of the concatenated recipient fields.
 */
export function checkUngroundedNumber(
  intro: string,
  recipient: GuardrailRecipientData
): GuardrailFailure | null {
  const digitSequences = intro.match(/\d+/g);
  if (!digitSequences || digitSequences.length === 0) {
    return null;
  }

  const recipientString = [
    recipient.first_name,
    recipient.company,
    recipient.role,
    recipient.note,
  ]
    .filter(Boolean)
    .join(" ");

  for (const seq of digitSequences) {
    if (!recipientString.includes(seq)) {
      return {
        code: "UNGROUNDED_NUMBER",
        detail: `Digit sequence "${seq}" does not appear in recipient fields`,
      };
    }
  }

  return null;
}
