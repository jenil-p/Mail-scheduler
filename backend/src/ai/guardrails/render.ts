import type { GuardrailFailure } from "./types";
import { escapeHtml } from "../../campaigns/render";

/**
 * RENDER_INVALID: renderedBody still contains "{{" or "}}",
 * or does not contain the HTML-escaped unsubscribeUrl, or renderedSubject is empty.
 */
export function checkRender(
  renderedSubject: string,
  renderedBody: string,
  unsubscribeUrl: string
): GuardrailFailure | null {
  if (renderedSubject.trim() === "") {
    return {
      code: "RENDER_INVALID",
      detail: "Rendered subject is empty",
    };
  }

  if (renderedBody.includes("{{") || renderedBody.includes("}}")) {
    return {
      code: "RENDER_INVALID",
      detail: "Rendered body still contains unexpanded template tags ({{ or }})",
    };
  }

  const escapedUnsubscribeUrl = escapeHtml(unsubscribeUrl);
  if (!renderedBody.includes(escapedUnsubscribeUrl)) {
    return {
      code: "RENDER_INVALID",
      detail: "Rendered body does not contain the HTML-escaped unsubscribe URL",
    };
  }

  return null;
}
