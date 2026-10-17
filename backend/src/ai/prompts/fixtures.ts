/**
 * Intro fixtures observed during smoke testing and local evaluation.
 * Used for Phase 4 guardrail testing and regression checks.
 */

export interface ObservedIntroFixture {
  intro: string;
  expectedFailureReason: string;
  description: string;
}

export const OBSERVED_SMOKE_OUTPUTS: readonly ObservedIntroFixture[] = [
  {
    intro: "Hi Priya, hope things are going smoothly at Acme Corp.",
    expectedFailureReason: "STARTS_WITH_GREETING",
    description: "Intro starting with greeting and recipient name (template already greets recipient)",
  },
  {
    intro: "I know how critical scaling operations is at Acme Corp, which is why our support automation workshop is a great fit.",
    expectedFailureReason: "UNGROUNDED_TOPIC",
    description: "Intro inventing and describing the event, offer, or topic of the email (workshop)",
  },
  {
    intro: "Greetings Priya, congratulations on your outstanding and brilliant leadership at Acme Corp!",
    expectedFailureReason: "STARTS_WITH_GREETING",
    description: "Intro with greeting and excessive flattery",
  },
] as const;
