/**
 * The one place that assembles the values a template is rendered with.
 *
 * Precedence, lowest to highest:
 *   1. `extra` columns from the CSV
 *   2. the recognized recipient fields (first_name, company, role, note)
 *   3. built-ins: `link` and `unsubscribe_link` from the campaign, and
 *      `ai_intro` only from the `aiIntro` argument
 *
 * A CSV column can therefore never fill or override `ai_intro`, `link` or
 * `unsubscribe_link`: `csv.ts` rejects those column names outright, and this
 * function skips them defensively for any `extra` that arrives from elsewhere
 * (an import, a fixture, a hand-built row).
 *
 * Every render must go through `renderCampaignEmail` so those rules cannot be
 * bypassed by rendering with a hand-made value map.
 */

import { normalizeHeaderName } from "./csv";
import {
  AI_SLOT_VARIABLE,
  LINK_VARIABLE,
  RESERVED_VARIABLES,
  UNSUBSCRIBE_VARIABLE,
  renderEmail,
  type TemplateValues,
} from "./render";

export interface TemplateCampaignInput {
  linkUrl: string;
  unsubscribeUrl: string;
}

export interface TemplateRecipientInput {
  firstName?: string | null;
  company?: string | null;
  role?: string | null;
  note?: string | null;
  /** Any non-recognized CSV columns, keyed by their original header text. */
  extra?: Record<string, unknown> | null;
}

const RESERVED = new Set<string>(RESERVED_VARIABLES);

function toText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function buildTemplateValues(
  recipient: TemplateRecipientInput,
  campaign: TemplateCampaignInput,
  aiIntro?: string | null
): TemplateValues {
  const values: TemplateValues = {};

  // 1. extras, lowest precedence; reserved names are never taken from data.
  for (const [key, raw] of Object.entries(recipient.extra ?? {})) {
    const name = normalizeHeaderName(key);
    if (name === "" || RESERVED.has(name)) continue;
    values[name] = toText(raw);
  }

  // 2. recognized recipient fields.
  values.first_name = toText(recipient.firstName);
  values.company = toText(recipient.company);
  values.role = toText(recipient.role);
  values.note = toText(recipient.note);

  // 3. built-ins, always from the campaign (and the draft's own intro).
  values[LINK_VARIABLE] = campaign.linkUrl;
  values[UNSUBSCRIBE_VARIABLE] = campaign.unsubscribeUrl;
  values[AI_SLOT_VARIABLE] =
    aiIntro !== null && aiIntro !== undefined && aiIntro.trim() !== "" ? aiIntro : undefined;

  return values;
}

export interface CampaignEmailInput {
  subjectTemplate: string;
  bodyTemplate: string;
  recipient: TemplateRecipientInput;
  campaign: TemplateCampaignInput;
  /** The AI-written sentence for this draft; omitted for fallback drafts. */
  aiIntro?: string | null;
}

/** The only supported way to render a campaign email. */
export function renderCampaignEmail({
  subjectTemplate,
  bodyTemplate,
  recipient,
  campaign,
  aiIntro,
}: CampaignEmailInput): { subject: string; body: string } {
  return renderEmail({
    subjectTemplate,
    bodyTemplate,
    values: buildTemplateValues(recipient, campaign, aiIntro),
  });
}
