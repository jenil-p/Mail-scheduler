import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../generated/prisma/client";
import { parseRecipientsCsv } from "./csv";

/**
 * Recipient persistence against a real Postgres. Gated on TEST_DATABASE_URL so
 * `npm test` stays offline; run with `npm run test:integration`.
 *
 * Point TEST_DATABASE_URL at a throwaway database — this suite creates and
 * deletes rows. All data here is fake (see the free-tier data-handling note).
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl ? describe : describe.skip;

const options = { maxRecipients: 500, fieldMaxLength: 200, noteMaxLength: 500 };

suite("persistRecipients (integration)", () => {
  let prisma: PrismaClient;
  let persistRecipients: typeof import("./recipients").persistRecipients;
  let campaignIds: string[] = [];

  beforeAll(async () => {
    // The pool reads DATABASE_URL when it is first imported, so set it first.
    process.env.DATABASE_URL = testDatabaseUrl;

    const [{ prisma: client }, recipientsModule] = await Promise.all([
      import("../db/pool"),
      import("./recipients"),
    ]);

    prisma = client;
    persistRecipients = recipientsModule.persistRecipients;
  });

  afterAll(async () => {
    if (campaignIds.length > 0) {
      await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    }
    await prisma.$disconnect();
  });

  async function createCampaign(): Promise<string> {
    const campaign = await prisma.campaign.create({
      data: {
        userId: "integration-test@example.com",
        name: "Integration test campaign",
        subjectTemplate: "Invitation",
        bodyTemplate: "Hi {{first_name}},\n\n{{ai_intro}}\n\n{{unsubscribe_link}}",
        templateHash: "integration-test-hash",
        linkUrl: "https://example.com/webinar",
        unsubscribeUrl: "https://example.com/unsubscribe",
        aiEnabled: true,
        scheduledAt: new Date(Date.now() + 3_600_000),
      },
    });

    campaignIds.push(campaign.id);
    return campaign.id;
  }

  it("stores parsed rows with extras, the personalization flag and the dedup report", async () => {
    const parsed = parseRecipientsCsv(
      [
        "email,first_name,company,role,note,city",
        "priya@example.com,Priya,Acme Corp,Head of Ops,met at a conference,Berlin",
        "raj@example.com,Raj,,,,",
        "priya@example.com,Duplicate,,,,",
      ].join("\n"),
      options
    );

    if (!parsed.ok) throw new Error(`expected ok, got ${parsed.code}`);

    expect(parsed.rejected.map((r) => r.code)).toEqual(["DUPLICATE_EMAIL"]);

    const campaignId = await createCampaign();
    const result = await persistRecipients(prisma, campaignId, parsed.recipients);

    expect(result).toEqual({ created: 2, skipped: 0 });

    const stored = await prisma.recipient.findMany({
      where: { campaignId },
      orderBy: { email: "asc" },
    });

    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      email: "priya@example.com",
      firstName: "Priya",
      company: "Acme Corp",
      role: "Head of Ops",
      note: "met at a conference",
      extra: { city: "Berlin" },
      hasPersonalizationData: true,
    });
    expect(stored[1]).toMatchObject({
      email: "raj@example.com",
      firstName: "Raj",
      extra: null,
      hasPersonalizationData: false,
    });
  });

  it("skips addresses the campaign already has, on the unique constraint", async () => {
    const campaignId = await createCampaign();
    const parsed = parseRecipientsCsv("email\na@example.com\nb@example.com\n", options);

    if (!parsed.ok) throw new Error(`expected ok, got ${parsed.code}`);

    const first = await persistRecipients(prisma, campaignId, parsed.recipients);
    const second = await persistRecipients(prisma, campaignId, parsed.recipients);

    expect(first).toEqual({ created: 2, skipped: 0 });
    expect(second).toEqual({ created: 0, skipped: 2 });

    const afterSecond = await persistRecipients(prisma, campaignId, [
      ...parsed.recipients,
      { rowNumber: 99, email: "c@example.com", hasPersonalizationData: false },
    ]);

    expect(afterSecond).toEqual({ created: 1, skipped: 2 });

    expect(await prisma.recipient.count({ where: { campaignId } })).toBe(3);
  });

  it("reports created + skipped as the parsed row count, and does nothing for an empty list", async () => {
    const campaignId = await createCampaign();

    expect(await persistRecipients(prisma, campaignId, [])).toEqual({ created: 0, skipped: 0 });

    const parsed = parseRecipientsCsv("email\nx@example.com\ny@example.com\n", options);
    if (!parsed.ok) throw new Error(`expected ok, got ${parsed.code}`);

    const result = await persistRecipients(prisma, campaignId, parsed.recipients);

    expect(result.created + result.skipped).toBe(parsed.recipients.length);
  });
});
