/**
 * Deterministic AI intro guardrails (Phase 4).
 * Pure functions, no new dependencies, no model calls.
 */

import type {
  GuardrailCode,
  GuardrailFailure,
  GuardrailInput,
  GuardrailRecipientData,
  GuardrailCampaignData,
} from "./types";
import { checkEmpty } from "./empty";
import { checkNewline } from "./newline";
import { checkLength } from "./length";
import { checkGreeting } from "./greeting";
import { checkForbidden } from "./forbidden";
import { checkUngroundedNumber } from "./numbers";
import { checkUngroundedEntity, ALLOWED_WORDS } from "./entity";
import { checkBannedPhrase, BANNED_PHRASES } from "./banned";
import { checkInjection, isInjectionSuspected, recipientHasInjection } from "./injection";
import { checkRender } from "./render";

export {
  type GuardrailCode,
  type GuardrailFailure,
  type GuardrailInput,
  type GuardrailRecipientData,
  type GuardrailCampaignData,
  ALLOWED_WORDS,
  BANNED_PHRASES,
  isInjectionSuspected,
  recipientHasInjection,
};

/**
 * Runs all deterministic guardrails on an intro and its rendered email.
 * Stateless and reusable: collects ALL failures and never throws.
 */
export function runGuardrails(input: GuardrailInput): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];

  // 1. EMPTY_INTRO
  const emptyFailure = checkEmpty(input.intro);
  if (emptyFailure) {
    failures.push(emptyFailure);
  }

  // 2. CONTAINS_NEWLINE
  const newlineFailure = checkNewline(input.intro);
  if (newlineFailure) {
    failures.push(newlineFailure);
  }

  // 3. TOO_LONG (reports from original length and full sentence count)
  const lengthFailure = checkLength(input.intro, input.introMaxChars);
  if (lengthFailure) {
    failures.push(lengthFailure);
  }

  // Linear-time guard: truncate intro to introMaxChars * 4 before regex checks
  const bound = input.introMaxChars * 4;
  const boundedIntro = input.intro.length > bound ? input.intro.slice(0, bound) : input.intro;

  // Run content checks only on non-empty intros
  if (!emptyFailure) {
    // 4. STARTS_WITH_GREETING
    const greetingFailure = checkGreeting(boundedIntro);
    if (greetingFailure) {
      failures.push(greetingFailure);
    }

    // 5. BANNED_PHRASE
    const bannedFailure = checkBannedPhrase(boundedIntro);
    if (bannedFailure) {
      failures.push(bannedFailure);
    }

    // 6. FORBIDDEN_CONTENT
    const forbiddenFailure = checkForbidden(boundedIntro);
    if (forbiddenFailure) {
      failures.push(forbiddenFailure);
    }

    // 7. UNGROUNDED_NUMBER
    const numberFailure = checkUngroundedNumber(boundedIntro, input.recipient);
    if (numberFailure) {
      failures.push(numberFailure);
    }

    // 8. UNGROUNDED_ENTITY
    const entityFailure = checkUngroundedEntity(boundedIntro, input.recipient);
    if (entityFailure) {
      failures.push(entityFailure);
    }

    // 9. INJECTION_SUSPECTED
    const injectionFailure = checkInjection(boundedIntro);
    if (injectionFailure) {
      failures.push(injectionFailure);
    }
  }

  // 10. RENDER_INVALID
  const renderFailure = checkRender(
    input.renderedSubject,
    input.renderedBody,
    input.campaign.unsubscribeUrl
  );
  if (renderFailure) {
    failures.push(renderFailure);
  }

  return failures;
}
