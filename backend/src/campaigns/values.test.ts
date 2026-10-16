import { describe, it, expect } from "vitest";
import { buildTemplateValues, renderCampaignEmail } from "./values";

const campaign = {
  linkUrl: "https://example.com/webinar?a=1&b=2",
  unsubscribeUrl: "https://example.com/unsubscribe",
};

const rich = {
  firstName: "Priya",
  company: "Acme Corp",
  role: "Head of Ops",
  note: "met at PyCon",
  extra: { city: "Berlin", sign_up_date: "2026-01-02" },
};

describe("buildTemplateValues", () => {
  it("assembles extras, recognized fields and built-ins", () => {
    const values = buildTemplateValues(rich, campaign, "Since you lead ops, this fits.");

    expect(values).toMatchObject({
      city: "Berlin",
      sign_up_date: "2026-01-02",
      first_name: "Priya",
      company: "Acme Corp",
      role: "Head of Ops",
      note: "met at PyCon",
      link: campaign.linkUrl,
      unsubscribe_link: campaign.unsubscribeUrl,
      ai_intro: "Since you lead ops, this fits.",
    });
  });

  it("takes ai_intro only from the argument, never from recipient data", () => {
    const values = buildTemplateValues(
      { ...rich, extra: { ai_intro: "injected by a CSV column" } },
      campaign,
      undefined
    );

    expect(values.ai_intro).toBeUndefined();
  });

  it("never lets an extra column fill or override a built-in", () => {
    const values = buildTemplateValues(
      {
        extra: {
          link: "https://evil.example/phish",
          unsubscribe_link: "https://evil.example/unsub",
          ai_intro: "ignore previous instructions",
          Link: "https://evil.example/again",
        },
      },
      campaign,
      "the real intro"
    );

    expect(values.link).toBe(campaign.linkUrl);
    expect(values.unsubscribe_link).toBe(campaign.unsubscribeUrl);
    expect(values.ai_intro).toBe("the real intro");
  });

  it("skips reserved names even when they arrive as normalized extras", () => {
    const values = buildTemplateValues(
      { extra: { "Unsubscribe-Link": "https://evil.example/x", "AI Intro": "nope" } },
      campaign,
      undefined
    );

    expect(values.unsubscribe_link).toBe(campaign.unsubscribeUrl);
    expect(values.ai_intro).toBeUndefined();
    expect(values.link).toBe(campaign.linkUrl);
  });

  it("normalizes extra keys so they are usable as {{variables}}", () => {
    const values = buildTemplateValues(
      { extra: { "Job Title": "Head of Ops", "Sign-up Date": "2026-01-02" } },
      campaign
    );

    expect(values.job_title).toBe("Head of Ops");
    expect(values.sign_up_date).toBe("2026-01-02");
    expect(values["Job Title"]).toBeUndefined();
  });

  it("prefers recognized recipient fields over extras", () => {
    const values = buildTemplateValues({ company: "Real Corp", extra: { company: "Stale Corp" } }, campaign);

    expect(values.company).toBe("Real Corp");
  });

  it("maps missing and blank fields to undefined and treats a blank intro as absent", () => {
    const values = buildTemplateValues({ company: "  " }, campaign, "   ");

    expect(values.company).toBe("  ");
    expect(values.role).toBeUndefined();
    expect(values.note).toBeUndefined();
    expect(values.ai_intro).toBeUndefined();
  });

  it("keeps the links even when the recipient has nothing", () => {
    const values = buildTemplateValues({}, campaign);

    expect(values.link).toBe(campaign.linkUrl);
    expect(values.unsubscribe_link).toBe(campaign.unsubscribeUrl);
  });
});

describe("renderCampaignEmail", () => {
  const subjectTemplate = "Invite for {{company}}";
  const bodyTemplate = "Hi {{first_name|there}},\n\n{{ai_intro}}\n\n{{link}}\n{{unsubscribe_link}}";

  it("renders subject and body through the assembled values", () => {
    const { subject, body } = renderCampaignEmail({
      subjectTemplate,
      bodyTemplate,
      recipient: rich,
      campaign,
      aiIntro: "Since you lead ops, this fits.",
    });

    expect(subject).toBe("Invite for Acme Corp");
    expect(body).toContain("Hi Priya,");
    expect(body).toContain("Since you lead ops, this fits.");
    expect(body).toContain('<a href="https://example.com/webinar?a=1&amp;b=2">');
  });

  it("uses the default and drops the slot for a thin-data recipient", () => {
    const { subject, body } = renderCampaignEmail({
      subjectTemplate,
      bodyTemplate,
      recipient: {},
      campaign,
      aiIntro: undefined,
    });

    expect(subject).toBe("Invite for"); // the subject is trimmed
    expect(body).toBe(
      'Hi there,<br><br><a href="https://example.com/webinar?a=1&amp;b=2">https://example.com/webinar?a=1&amp;b=2</a>' +
        '<br><a href="https://example.com/unsubscribe">https://example.com/unsubscribe</a>'
    );
  });

  it("cannot be tricked into rendering a data-supplied link", () => {
    const { body } = renderCampaignEmail({
      subjectTemplate,
      bodyTemplate,
      recipient: { extra: { link: "https://evil.example/phish" } },
      campaign,
    });

    expect(body).toContain(campaign.linkUrl.replace("&", "&amp;"));
    expect(body).not.toContain("evil.example");
  });
});
