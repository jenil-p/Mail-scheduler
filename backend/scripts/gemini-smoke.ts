/**
 * Manual Gemini smoke test — run this before trusting the 429 handling.
 *
 *   cd backend
 *   LLM_API_KEY=... LLM_MODEL=gemini-2.5-flash npx tsx scripts/gemini-smoke.ts
 *   LLM_API_KEY=... LLM_MODEL=gemini-2.5-flash npx tsx scripts/gemini-smoke.ts --burst 8
 *
 * Why it exists: the installed SDK's `ApiError` carries **only** the HTTP status
 * and a message that is `JSON.stringify(<error body>)`, and the exact layout of the
 * structured 429 body could not be confirmed from the official docs while
 * `src/ai/llm/geminiErrors.ts` was written. Rather than guess, this script makes a
 * real call with the exact config the client uses and prints:
 *
 *   1. the raw success response (text, finishReason, usageMetadata), and
 *   2. on failure, the raw error (status + message string **verbatim**) next to the
 *      analysis our parser derives from it — so a mismatch between the real shape
 *      and the parser is visible at a glance.
 *
 * `--burst N` sends N calls back to back and stops at the first error, which is the
 * cheapest way to see a real 429 on a free-tier key (the per-minute limit is small).
 *
 * It writes nothing to the database, sends no recipient data (the fixture below is
 * fake), and never prints the API key.
 *
 * Exit code is 0 when the call(s) succeeded or when the only failures were handled
 * by the parser, and 1 when the parser could not classify a failure — the case that
 * needs the parser fixed before the feature can be trusted against a real key.
 */

import { GoogleGenAI } from "@google/genai";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_THINKING_BUDGET,
} from "../src/ai/llm/gemini";
import { INTRO_RESPONSE_SCHEMA } from "../src/ai/llm/LlmClient";
import { analyzeGeminiError } from "../src/ai/llm/geminiErrors";
import { SYSTEM_PROMPT } from "../src/ai/prompts/personalize.v1";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;

if (!apiKey) fail("Set LLM_API_KEY (Google AI Studio key) before running this script.");
if (!model) fail("Set LLM_MODEL (the model id you picked in AI Studio) before running this script.");

const burstIndex = process.argv.indexOf("--burst");
const burst = burstIndex === -1 ? 1 : Math.max(1, Number(process.argv[burstIndex + 1] ?? 1));

/** Fake, fixed data — this script must never carry real recipient information. */
const user = [
  "STYLE INSTRUCTION: Warm, brief, no flattery.",
  "EMAIL PURPOSE: Hi {{first_name}},  We are running a short workshop on support automation.",
  "<recipient_data>",
  JSON.stringify({ first_name: "Priya", company: "Acme Corp", role: "Head of Ops" }),
  "</recipient_data>",
].join("\n");

const ai = new GoogleGenAI({ apiKey });

let unclassified = 0;

for (let attempt = 1; attempt <= burst; attempt++) {
  console.log(`\n=== call ${attempt}/${burst} — model ${model} ===`);

  try {
    const response = await ai.models.generateContent({
      model,
      contents: user,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: DEFAULT_TEMPERATURE,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        responseMimeType: "application/json",
        responseJsonSchema: INTRO_RESPONSE_SCHEMA,
        thinkingConfig: { thinkingBudget: DEFAULT_THINKING_BUDGET },
        httpOptions: { retryOptions: { attempts: 1 } },
      },
    });

    console.log("OK");
    console.log("  finishReason:", response.candidates?.[0]?.finishReason ?? "(none)");
    console.log("  modelVersion:", response.modelVersion ?? "(none)");
    console.log("  usageMetadata:", JSON.stringify(response.usageMetadata ?? {}));
    console.log("  text:", JSON.stringify(response.text ?? ""));
  } catch (error) {
    const status = (error as { status?: number }).status;
    const message = (error as { message?: string }).message ?? String(error);

    console.log("FAILED");
    console.log("  error name:", (error as Error).name);
    console.log("  HTTP status:", status ?? "(none on the error object)");
    console.log("  raw message (verbatim, this is the body the parser sees):");
    console.log(message);

    if (typeof status === "number") {
      const analysis = analyzeGeminiError(status, message);
      console.log("  parser analysis:", JSON.stringify(analysis, null, 2));

      const classified =
        analysis.scope === "per_day"
          ? "daily quota → FALLBACK + short-circuit the campaign"
          : "per-minute → retry with backoff";

      console.log(`  parser verdict: ${analysis.scope} → ${classified}`);
    } else {
      unclassified += 1;
      console.log("  ⚠ the error carries no HTTP status, so the parser never sees this shape");
    }

    // Stop the burst at the first failure: that is the error we came to inspect.
    break;
  }
}

if (unclassified > 0) {
  console.error(
    "\n⚠ A failure had no HTTP status (see above). The Gemini client classifies only " +
      "`ApiError` (which always has a status) and treats the rest as a transient network " +
      "fault, so this shape must be handled explicitly in src/ai/llm/gemini.ts."
  );
  process.exit(1);
}

console.log(
  "\nDone. If a 429 above was parsed as the wrong scope, fix `analyzeGeminiError` in " +
    "src/ai/llm/geminiErrors.ts and re-run this script."
);
