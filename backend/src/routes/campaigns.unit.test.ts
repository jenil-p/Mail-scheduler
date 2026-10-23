import { describe, expect, it, vi } from "vitest";
import { ZodError, z } from "zod";
import {
  mapCampaignError,
  createCampaignSchema,
  regenerateSamplesSchema,
  approveSamplesSchema,
  resolveDraftSchema,
  bulkResolveSchema,
} from "./campaigns";
import { IllegalTransitionError } from "../campaigns/stateMachine";
import {
  InvalidInstructionError,
  EmptyCampaignError,
} from "../campaigns/flow";
import {
  HardBlockedError,
  DraftNotFoundError,
  CampaignNotFoundError,
  CampaignNotUnderReviewError,
  StaleDraftError,
  IntroTooLongError,
} from "../campaigns/drafts";
import { IdentityMismatchError } from "../campaigns/control";

describe("mapCampaignError (Phase 7a)", () => {
  it("maps IllegalTransitionError to 409 ILLEGAL_STATE", () => {
    const err = new IllegalTransitionError("DRAFT", "SCHEDULED");
    const { status, body } = mapCampaignError(err);
    expect(status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: {
        code: "ILLEGAL_STATE",
        message: err.message,
      },
    });
  });

  it("maps InvalidInstructionError to 422 INVALID_INSTRUCTION", () => {
    const err = new InvalidInstructionError("Instruction is invalid");
    const { status, body } = mapCampaignError(err);
    expect(status).toBe(422);
    expect(body).toEqual({
      success: false,
      error: {
        code: "INVALID_INSTRUCTION",
        message: "Instruction is invalid",
      },
    });
  });

  it("maps EmptyCampaignError to 422 EMPTY_CAMPAIGN", () => {
    const err = new EmptyCampaignError("Campaign has zero recipients");
    const { status, body } = mapCampaignError(err);
    expect(status).toBe(422);
    expect(body).toEqual({
      success: false,
      error: {
        code: "EMPTY_CAMPAIGN",
        message: "Campaign has zero recipients",
      },
    });
  });

  it("maps HardBlockedError to 409 HARD_BLOCKED with details.blockedCodes", () => {
    const err = new HardBlockedError(["FORBIDDEN_CONTENT", "RENDER_INVALID"]);
    const { status, body } = mapCampaignError(err);
    expect(status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: {
        code: "HARD_BLOCKED",
        message: err.message,
        details: {
          blockedCodes: ["FORBIDDEN_CONTENT", "RENDER_INVALID"],
        },
      },
    });
  });

  it("maps CampaignNotUnderReviewError to 409 CAMPAIGN_NOT_UNDER_REVIEW", () => {
    const err = new CampaignNotUnderReviewError("Not under review");
    const { status, body } = mapCampaignError(err);
    expect(status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: {
        code: "CAMPAIGN_NOT_UNDER_REVIEW",
        message: "Not under review",
      },
    });
  });

  it("maps StaleDraftError to 409 STALE_DRAFT", () => {
    const err = new StaleDraftError("Draft is stale");
    const { status, body } = mapCampaignError(err);
    expect(status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: {
        code: "STALE_DRAFT",
        message: "Draft is stale",
      },
    });
  });

  it("maps IdentityMismatchError to 409 IDENTITY_MISMATCH_AFTER_APPROVAL", () => {
    const err = new IdentityMismatchError("Identity mismatch");
    const { status, body } = mapCampaignError(err);
    expect(status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: {
        code: "IDENTITY_MISMATCH_AFTER_APPROVAL",
        message: "Identity mismatch",
      },
    });
  });

  it("maps IntroTooLongError to 422 INTRO_TOO_LONG", () => {
    const err = new IntroTooLongError("AI intro exceeds maximum allowed length");
    const { status, body } = mapCampaignError(err);
    expect(status).toBe(422);
    expect(body).toEqual({
      success: false,
      error: {
        code: "INTRO_TOO_LONG",
        message: "AI intro exceeds maximum allowed length",
      },
    });
  });

  it("maps DraftNotFoundError to 404 DRAFT_NOT_FOUND", () => {
    const err = new DraftNotFoundError();
    const { status, body } = mapCampaignError(err);
    expect(status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: {
        code: "DRAFT_NOT_FOUND",
        message: "Draft not found",
      },
    });
  });

  it("maps CampaignNotFoundError to 404 CAMPAIGN_NOT_FOUND", () => {
    const err = new CampaignNotFoundError();
    const { status, body } = mapCampaignError(err);
    expect(status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: {
        code: "CAMPAIGN_NOT_FOUND",
        message: "Campaign not found",
      },
    });
  });

  it("maps ZodError to 422 VALIDATION_FAILED with field paths", () => {
    const testSchema = z.object({
      fieldA: z.string().min(3),
      nested: z.object({
        fieldB: z.number(),
      }),
    });

    const parseResult = testSchema.safeParse({ fieldA: "a", nested: { fieldB: "not-a-number" } });
    expect(parseResult.success).toBe(false);

    if (!parseResult.success) {
      const { status, body } = mapCampaignError(parseResult.error);
      expect(status).toBe(422);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("VALIDATION_FAILED");
      expect(body.error.details).toHaveProperty("issues");
      const details = body.error.details as { issues: Array<{ path: string; message: string }> };
      expect(details.issues.some((i) => i.path === "fieldA")).toBe(true);
      expect(details.issues.some((i) => i.path === "nested.fieldB")).toBe(true);
    }
  });

  it("maps body-parser entity.too.large to 413 PAYLOAD_TOO_LARGE", () => {
    const err = { type: "entity.too.large", status: 413, message: "request entity too large" };
    const { status, body } = mapCampaignError(err);
    expect(status).toBe(413);
    expect(body).toEqual({
      success: false,
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Payload too large",
      },
    });
  });

  it("maps body-parser entity.parse.failed to 400 INVALID_JSON", () => {
    const err = { type: "entity.parse.failed", status: 400, message: "Unexpected token" };
    const { status, body } = mapCampaignError(err);
    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: {
        code: "INVALID_JSON",
        message: "Invalid JSON payload",
      },
    });
  });

  it("maps unhandled/generic errors to 500 INTERNAL_ERROR without leaking secrets, stack traces or SQL", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    class CustomDatabaseError extends Error {
      sql = "SELECT * FROM users WHERE email = 'secret@example.com'";
    }
    const err = new CustomDatabaseError("Connection lost");

    const { status, body } = mapCampaignError(err);
    expect(status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      },
    });

    // Verify error class only was logged
    expect(consoleSpy).toHaveBeenCalledWith("[Campaigns] Internal error: CustomDatabaseError");

    consoleSpy.mockRestore();
  });
});

describe("schemas (Phase 7a)", () => {
  it("validates createCampaignSchema correctly", () => {
    const valid = {
      name: "Q4 Outreach",
      subjectTemplate: "Hello {{first_name}}",
      bodyTemplate: "Hi {{first_name}}, check {{link}} and {{unsubscribe_link}}",
      linkUrl: "https://example.com/demo",
      unsubscribeUrl: "https://example.com/unsub",
      aiEnabled: true,
      aiInstruction: "Be professional",
      reviewMode: "SAMPLE",
      onUnresolved: "FALLBACK_TO_PLAIN",
      scheduledAt: "2026-12-01T10:00:00Z",
      csv: "email,first_name\nalice@example.com,Alice",
      dryRun: false,
    };

    const parsed = createCampaignSchema.safeParse(valid);
    expect(parsed.success).toBe(true);

    // Empty name rejected
    const badName = createCampaignSchema.safeParse({ ...valid, name: "   " });
    expect(badName.success).toBe(false);

    // Name too long rejected
    const longName = createCampaignSchema.safeParse({ ...valid, name: "a".repeat(121) });
    expect(longName.success).toBe(false);

    // Invalid reviewMode
    const badMode = createCampaignSchema.safeParse({ ...valid, reviewMode: "UNKNOWN" });
    expect(badMode.success).toBe(false);
  });

  it("validates regenerateSamplesSchema correctly", () => {
    expect(regenerateSamplesSchema.safeParse({}).success).toBe(true);
    expect(regenerateSamplesSchema.safeParse({ aiInstruction: "new tone" }).success).toBe(true);
    expect(regenerateSamplesSchema.safeParse({ aiInstruction: null }).success).toBe(true);
  });

  it("validates approveSamplesSchema correctly", () => {
    expect(approveSamplesSchema.safeParse({}).success).toBe(true);
    expect(approveSamplesSchema.safeParse({ acknowledgeBudgetWarning: true }).success).toBe(true);
    expect(approveSamplesSchema.safeParse({ acknowledgeBudgetWarning: false }).success).toBe(true);
    expect(approveSamplesSchema.safeParse({ acknowledgeBudgetWarning: "not-bool" }).success).toBe(false);
  });

  it("validates resolveDraftSchema correctly", () => {
    expect(resolveDraftSchema.safeParse({ type: "approve" }).success).toBe(true);
    expect(resolveDraftSchema.safeParse({ type: "use_plain" }).success).toBe(true);
    expect(resolveDraftSchema.safeParse({ type: "edit", aiIntro: "Custom intro" }).success).toBe(true);

    // edit without aiIntro is invalid
    expect(resolveDraftSchema.safeParse({ type: "edit" }).success).toBe(false);
    // unknown type is invalid
    expect(resolveDraftSchema.safeParse({ type: "reject" }).success).toBe(false);
  });

  it("validates bulkResolveSchema correctly", () => {
    expect(bulkResolveSchema.safeParse({ type: "approve" }).success).toBe(true);
    expect(bulkResolveSchema.safeParse({ type: "use_plain", codes: ["FORBIDDEN_CONTENT"] }).success).toBe(true);
    expect(bulkResolveSchema.safeParse({ type: "invalid" }).success).toBe(false);
  });
});
