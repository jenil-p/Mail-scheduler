/**
 * Recipient persistence.
 *
 * The parser already reports in-file duplicates with row numbers (FR-2); this
 * layer protects against the other direction — re-submitting or racing the same
 * address — by relying on the database's unique (campaign_id, email) constraint
 * with `skipDuplicates`. `skipped` therefore counts addresses the database
 * already had.
 *
 * Takes the client as an argument so the caller can run it inside the same
 * transaction that creates the campaign.
 */

import type { Prisma } from "../generated/prisma/client";
import type { ParsedRecipient } from "./csv";

export interface PersistRecipientsResult {
  created: number;
  skipped: number;
}

export async function persistRecipients(
  db: Prisma.TransactionClient,
  campaignId: string,
  recipients: readonly ParsedRecipient[]
): Promise<PersistRecipientsResult> {
  if (recipients.length === 0) {
    return { created: 0, skipped: 0 };
  }

  const { count } = await db.recipient.createMany({
    data: recipients.map((recipient) => ({
      campaignId,
      email: recipient.email,
      firstName: recipient.firstName ?? null,
      company: recipient.company ?? null,
      role: recipient.role ?? null,
      note: recipient.note ?? null,
      extra: recipient.extra ?? undefined,
      hasPersonalizationData: recipient.hasPersonalizationData,
    })),
    skipDuplicates: true,
  });

  return { created: count, skipped: recipients.length - count };
}

/**
 * Read back the recipients of a campaign in a stable order, which the sample
 * selection (Phase 5) relies on.
 */
export async function listRecipients(db: Prisma.TransactionClient, campaignId: string) {
  return db.recipient.findMany({
    where: { campaignId },
    orderBy: { createdAt: "asc" },
  });
}
