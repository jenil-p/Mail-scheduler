/**
 * Campaign HTTP API (Phase 7a).
 *
 * Implements endpoints for campaign creation, listing, inspection, control,
 * sample review, draft resolution, and bulk review.
 *
 * All routes require authentication (`authenticate` middleware).
 * `userId` is strictly derived from `req.user.email`.
 * All error responses adhere to the standard envelope:
 *   `{ success: false, error: { code, message, details? } }`
 */

import { Router, Request, Response, NextFunction } from "express";
import express from "express";
import { createHash } from "node:crypto";
import { z, ZodError } from "zod";
import { prisma } from "../db/pool";
import { config } from "../config";
import { authenticate } from "../middleware/auth";
import { parseRecipientsCsv } from "../campaigns/csv";
import {
  normalizeTemplateText,
  validateTemplate,
  type TemplateValidationIssue,
  type TemplateWarning,
} from "../campaigns/template";
import { buildTemplateValues } from "../campaigns/values";
import { persistRecipients } from "../campaigns/recipients";
import {
  startSampling,
  regenerateSamples,
  approveSamples,
  startPlainCampaign,
  InvalidInstructionError,
  EmptyCampaignError,
} from "../campaigns/flow";
import {
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  IdentityMismatchError,
} from "../campaigns/control";
import {
  resolveDraft,
  bulkResolve,
  listDrafts,
  getCampaignSummary,
  HardBlockedError,
  DraftNotFoundError,
  CampaignNotFoundError,
  CampaignNotUnderReviewError,
  StaleDraftError,
  IntroTooLongError,
} from "../campaigns/drafts";
import { IllegalTransitionError } from "../campaigns/stateMachine";
import { getCampaignRuntime } from "../campaigns/runtime";

// --- Validation Schemas ---

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "Name must be 1-120 characters"),
  subjectTemplate: z.string(),
  bodyTemplate: z.string(),
  linkUrl: z.string(),
  unsubscribeUrl: z.string(),
  aiEnabled: z.boolean(),
  aiInstruction: z.string().optional().nullable(),
  reviewMode: z.enum(["SAMPLE", "FULL"]).default("SAMPLE"),
  onUnresolved: z.enum(["FALLBACK_TO_PLAIN", "HOLD"]).default("FALLBACK_TO_PLAIN"),
  scheduledAt: z.string(),
  csv: z.string(),
  dryRun: z.boolean().optional().default(false),
});

export const regenerateSamplesSchema = z.object({
  aiInstruction: z.string().optional().nullable(),
});

export const approveSamplesSchema = z.object({
  acknowledgeBudgetWarning: z.boolean().optional(),
});

export const resolveDraftSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve") }),
  z.object({ type: z.literal("use_plain") }),
  z.object({ type: z.literal("edit"), aiIntro: z.string() }),
]);

export const bulkResolveSchema = z.object({
  type: z.enum(["approve", "use_plain"]),
  codes: z.array(z.string()).optional(),
});

// --- Error Mapper ---

export interface CampaignApiErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function mapCampaignError(err: unknown): {
  status: number;
  body: CampaignApiErrorEnvelope;
} {
  // 1. Zod schema errors
  if (err instanceof ZodError) {
    return {
      status: 422,
      body: {
        success: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "Validation failed",
          details: {
            issues: err.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        },
      },
    };
  }

  // 2. Body-parser errors
  const anyErr = err as any;
  if (anyErr?.type === "entity.too.large" || anyErr?.status === 413) {
    return {
      status: 413,
      body: {
        success: false,
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Payload too large",
        },
      },
    };
  }

  if (
    anyErr?.type === "entity.parse.failed" ||
    (err instanceof SyntaxError && anyErr?.status === 400)
  ) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: "INVALID_JSON",
          message: "Invalid JSON payload",
        },
      },
    };
  }

  // 3. Known domain errors
  if (err instanceof IllegalTransitionError) {
    return {
      status: 409,
      body: {
        success: false,
        error: {
          code: "ILLEGAL_STATE",
          message: err.message,
        },
      },
    };
  }

  if (err instanceof InvalidInstructionError) {
    return {
      status: 422,
      body: {
        success: false,
        error: {
          code: "INVALID_INSTRUCTION",
          message: err.message,
        },
      },
    };
  }

  if (err instanceof EmptyCampaignError) {
    return {
      status: 422,
      body: {
        success: false,
        error: {
          code: "EMPTY_CAMPAIGN",
          message: err.message,
        },
      },
    };
  }

  if (err instanceof HardBlockedError) {
    return {
      status: 409,
      body: {
        success: false,
        error: {
          code: "HARD_BLOCKED",
          message: err.message,
          details: {
            blockedCodes: err.blockedCodes,
          },
        },
      },
    };
  }

  if (err instanceof CampaignNotUnderReviewError) {
    return {
      status: 409,
      body: {
        success: false,
        error: {
          code: "CAMPAIGN_NOT_UNDER_REVIEW",
          message: err.message,
        },
      },
    };
  }

  if (err instanceof StaleDraftError) {
    return {
      status: 409,
      body: {
        success: false,
        error: {
          code: "STALE_DRAFT",
          message: err.message,
        },
      },
    };
  }

  if (err instanceof IdentityMismatchError) {
    return {
      status: 409,
      body: {
        success: false,
        error: {
          code: "IDENTITY_MISMATCH_AFTER_APPROVAL",
          message: err.message,
        },
      },
    };
  }

  if (err instanceof IntroTooLongError) {
    return {
      status: 422,
      body: {
        success: false,
        error: {
          code: "INTRO_TOO_LONG",
          message: err.message,
        },
      },
    };
  }

  if (err instanceof DraftNotFoundError) {
    return {
      status: 404,
      body: {
        success: false,
        error: {
          code: "DRAFT_NOT_FOUND",
          message: "Draft not found",
        },
      },
    };
  }

  if (err instanceof CampaignNotFoundError) {
    return {
      status: 404,
      body: {
        success: false,
        error: {
          code: "CAMPAIGN_NOT_FOUND",
          message: "Campaign not found",
        },
      },
    };
  }

  // 4. Default / unknown error: 500 INTERNAL_ERROR
  const errClass = (err as Error)?.constructor?.name || (err as Error)?.name || "Error";
  console.error(`[Campaigns] Internal error: ${errClass}`);

  return {
    status: 500,
    body: {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      },
    },
  };
}

// Helper wrapper for async route handlers
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// Middleware: verifies campaign ownership and attaches campaign to req
async function requireUserCampaign(req: Request, res: Response, next: NextFunction) {
  const id = String(req.params.id);
  const userEmail = req.user?.email;

  const campaign = await prisma.campaign.findUnique({
    where: { id },
  });

  // Return identical 404 when campaign does not exist OR belongs to another user
  if (!campaign || campaign.userId !== userEmail) {
    res.status(404).json({
      success: false,
      error: {
        code: "CAMPAIGN_NOT_FOUND",
        message: "Campaign not found",
      },
    });
    return;
  }

  (req as any).campaign = campaign;
  next();
}

// --- Router Definition ---

const router = Router();

// Authenticate all routes BEFORE body parsing so unauthenticated requests are rejected before any body is read
router.use(authenticate);

// Router's own 1mb parser (mounted before global 10mb parser)
router.use(express.json({ limit: "1mb" }));

/**
 * 1. POST /api/campaigns
 * Create or dry-run a campaign with recipients CSV.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const parse = createCampaignSchema.safeParse(req.body);
    if (!parse.success) {
      throw parse.error;
    }

    const {
      name,
      subjectTemplate,
      bodyTemplate,
      linkUrl,
      unsubscribeUrl,
      aiEnabled,
      aiInstruction,
      reviewMode,
      onUnresolved,
      scheduledAt,
      csv,
      dryRun,
    } = parse.data;

    const normalizedSubject = normalizeTemplateText(subjectTemplate);
    const normalizedBody = normalizeTemplateText(bodyTemplate);
    const ai = config.ai;

    // Parse recipients CSV
    const csvResult = parseRecipientsCsv(csv, {
      maxRecipients: ai.maxRecipientsPerCampaign,
      fieldMaxLength: ai.recipientFieldMaxLength,
      noteMaxLength: ai.recipientNoteMaxLength,
    });

    // Validate scheduledAt
    const scheduledDate = new Date(scheduledAt);
    const isDateValid = !isNaN(scheduledDate.getTime());
    const isTooSoon = isDateValid && scheduledDate.getTime() < Date.now() + ai.minLeadTimeMs;

    // Validate templates and recipient values
    const recipientValues = csvResult.ok
      ? csvResult.recipients.map((r) =>
          buildTemplateValues(
            {
              firstName: r.firstName,
              company: r.company,
              role: r.role,
              note: r.note,
              extra: r.extra,
            },
            { linkUrl, unsubscribeUrl }
          )
        )
      : [];

    const templateResult = validateTemplate({
      subject: normalizedSubject,
      body: normalizedBody,
      aiEnabled,
      csvVariables: csvResult.ok ? csvResult.extraColumns : [],
      linkUrl,
      unsubscribeUrl,
      recipientValues,
      subjectMaxLength: ai.templateSubjectMaxLength,
      bodyMaxLength: ai.templateBodyMaxLength,
    });

    // Collect all blocking errors
    const errors: Array<{ code: string; message: string; field?: string }> = [];

    if (!csvResult.ok) {
      errors.push({ code: csvResult.code, message: csvResult.message });
    } else if (csvResult.recipients.length === 0) {
      errors.push({ code: "EMPTY_CAMPAIGN", message: "Campaign has zero recipients" });
    }

    for (const tErr of templateResult.errors) {
      errors.push(tErr);
    }

    if (!isDateValid) {
      errors.push({ code: "INVALID_SCHEDULED_AT", message: "scheduledAt must be a valid ISO date" });
    } else if (isTooSoon) {
      errors.push({
        code: "SCHEDULE_TOO_SOON",
        message: `scheduledAt must be at least ${ai.minLeadTimeMs}ms in the future`,
      });
    }

    if (reviewMode === "FULL") {
      errors.push({
        code: "FULL_REVIEW_NOT_AVAILABLE",
        message: "Full review of every draft is not available yet; use SAMPLE",
      });
    }

    if (!aiEnabled && aiInstruction !== undefined && aiInstruction !== null && aiInstruction.trim() !== "") {
      errors.push({
        code: "AI_INSTRUCTION_NOT_ALLOWED",
        message: "aiInstruction must not be provided when aiEnabled is false",
      });
    }

    if (aiEnabled && aiInstruction && aiInstruction.trim().length > ai.instructionMaxLength) {
      errors.push({
        code: "INVALID_INSTRUCTION",
        message: `AI instruction exceeds maximum length of ${ai.instructionMaxLength} characters`,
      });
    }

    const warnings: TemplateWarning[] = templateResult.warnings;
    const rejected = csvResult.ok ? csvResult.rejected.slice(0, 100) : [];
    const rejectedCount = csvResult.ok ? csvResult.rejectedCount : 0;
    const headerMapping = csvResult.ok ? csvResult.headerMapping : {};
    const extraColumns = csvResult.ok ? csvResult.extraColumns : [];

    // Any blocking problem returns 422 with details
    if (errors.length > 0) {
      const primary =
        errors.find((e) => e.code === "FULL_REVIEW_NOT_AVAILABLE") ??
        errors.find((e) => e.code === "SCHEDULE_TOO_SOON") ??
        errors.find((e) => e.code === "RESERVED_COLUMN") ??
        errors.find((e) => e.code === "TOO_MANY_RECIPIENTS") ??
        errors.find((e) => e.code === "AI_INSTRUCTION_NOT_ALLOWED") ??
        (errors.length === 1 ? errors[0] : null);

      const primaryCode = primary?.code ?? "VALIDATION_FAILED";
      const primaryMessage =
        primary?.code === "FULL_REVIEW_NOT_AVAILABLE"
          ? primary.message
          : "Campaign validation failed";

      res.status(422).json({
        success: false,
        error: {
          code: primaryCode,
          message: primaryMessage,
          details: {
            errors,
            warnings,
            rejected,
            rejectedCount,
            headerMapping,
            extraColumns,
          },
        },
      });
      return;
    }

    // dryRun true returns 200 with the report and creates nothing
    if (dryRun) {
      res.status(200).json({
        success: true,
        data: {
          errors: [],
          warnings,
          rejected,
          rejectedCount,
          headerMapping,
          extraColumns,
        },
      });
      return;
    }

    // Create campaign and persist recipients in one transaction
    const templateHash = createHash("sha256")
      .update(`${normalizedSubject}\u0000${normalizedBody}`, "utf8")
      .digest("hex");

    const campaign = await prisma.$transaction(async (tx) => {
      const created = await tx.campaign.create({
        data: {
          userId: req.user!.email,
          name,
          subjectTemplate: normalizedSubject,
          bodyTemplate: normalizedBody,
          templateHash,
          linkUrl,
          unsubscribeUrl,
          aiEnabled,
          aiInstruction: aiEnabled && aiInstruction ? aiInstruction.trim() : null,
          reviewMode,
          onUnresolved,
          scheduledAt: scheduledDate,
          status: "DRAFT",
        },
      });

      await persistRecipients(tx, created.id, (csvResult as any).recipients);
      return created;
    });

    res.status(201).json({
      success: true,
      data: {
        campaignId: campaign.id,
        status: campaign.status,
        recipients: {
          accepted: (csvResult as any).recipients.length,
          rejectedCount,
          rejected,
        },
        warnings,
        headerMapping,
      },
    });
  })
);

/**
 * 2. GET /api/campaigns
 * The caller's campaigns, cursor-paged (limit default 20, max 50), newest first.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const cursor =
      typeof req.query.cursor === "string" && req.query.cursor.trim() !== ""
        ? req.query.cursor.trim()
        : undefined;

    const campaigns = await prisma.campaign.findMany({
      where: { userId: req.user!.email },
      take: limit,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        name: true,
        status: true,
        aiEnabled: true,
        scheduledAt: true,
        errorMessage: true,
        _count: {
          select: { recipients: true },
        },
      },
    });

    const data = campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      aiEnabled: c.aiEnabled,
      scheduledAt: c.scheduledAt,
      errorMessage: c.errorMessage,
      recipientCount: c._count.recipients,
    }));

    res.json({ success: true, data });
  })
);

/**
 * 3. GET /api/campaigns/:id
 * Campaign fields plus getCampaignSummary.
 */
router.get(
  "/:id",
  requireUserCampaign,
  asyncHandler(async (req: Request, res: Response) => {
    const campaign = (req as any).campaign;
    const summary = await getCampaignSummary(campaign.id);

    res.json({
      success: true,
      data: {
        id: campaign.id,
        name: campaign.name,
        subjectTemplate: campaign.subjectTemplate,
        bodyTemplate: campaign.bodyTemplate,
        linkUrl: campaign.linkUrl,
        unsubscribeUrl: campaign.unsubscribeUrl,
        aiEnabled: campaign.aiEnabled,
        aiInstruction: campaign.aiInstruction,
        reviewMode: campaign.reviewMode,
        onUnresolved: campaign.onUnresolved,
        scheduledAt: campaign.scheduledAt,
        status: campaign.status,
        errorMessage: campaign.errorMessage,
        summary,
        recipientCount: summary.recipientCount,
        draftCounts: summary.draftCounts,
        counts: summary.counts,
        sendCounts: summary.sendCounts,
      },
    });
  })
);

/**
 * 4. POST /api/campaigns/:id/start
 * aiEnabled ? startSampling : startPlainCampaign. Returns the new status.
 */
router.post(
  "/:id/start",
  requireUserCampaign,
  asyncHandler(async (req: Request, res: Response) => {
    const campaign = (req as any).campaign;
    let newStatus: string;

    if (campaign.aiEnabled) {
      await startSampling(campaign.id);
      newStatus = "SAMPLING";
    } else {
      await startPlainCampaign(campaign.id);
      newStatus = "SCHEDULED";
    }

    res.json({
      success: true,
      data: { status: newStatus },
    });
  })
);

/**
 * 5. POST /api/campaigns/:id/samples/regenerate
 * body { aiInstruction? } -> regenerateSamples.
 */
router.post(
  "/:id/samples/regenerate",
  requireUserCampaign,
  asyncHandler(async (req: Request, res: Response) => {
    const parse = regenerateSamplesSchema.safeParse(req.body);
    if (!parse.success) {
      throw parse.error;
    }

    const campaign = (req as any).campaign;
    await regenerateSamples(campaign.id, { aiInstruction: parse.data.aiInstruction });

    res.json({
      success: true,
      data: { status: "SAMPLING" },
    });
  })
);

/**
 * 6. POST /api/campaigns/:id/approve
 * body { acknowledgeBudgetWarning? } -> approveSamples.
 */
router.post(
  "/:id/approve",
  requireUserCampaign,
  asyncHandler(async (req: Request, res: Response) => {
    const parse = approveSamplesSchema.safeParse(req.body);
    if (!parse.success) {
      throw parse.error;
    }

    const campaign = (req as any).campaign;
    const runtime = getCampaignRuntime();

    const result = await approveSamples(
      campaign.id,
      { acknowledgeBudgetWarning: parse.data.acknowledgeBudgetWarning },
      {
        dailyLimit: config.ai.dailyRateLimit,
        getDailyUsage: runtime.getDailyUsage,
      }
    );

    if (!result.ok && result.code === "BUDGET_WARNING") {
      res.status(409).json({
        success: false,
        error: {
          code: "BUDGET_WARNING",
          message: `Campaign requires ${result.needed} generations, but only ${result.remaining} remaining today.`,
          details: {
            needed: result.needed,
            remaining: result.remaining,
          },
        },
      });
      return;
    }

    res.json({
      success: true,
      data: { status: "GENERATING" },
    });
  })
);

/**
 * 7. POST /api/campaigns/:id/pause, /resume, /cancel
 */
router.post(
  "/:id/pause",
  requireUserCampaign,
  asyncHandler(async (req: Request, res: Response) => {
    const campaign = (req as any).campaign;
    await pauseCampaign(campaign.id);
    res.json({ success: true, data: { status: "PAUSED" } });
  })
);

router.post(
  "/:id/resume",
  requireUserCampaign,
  asyncHandler(async (req: Request, res: Response) => {
    const campaign = (req as any).campaign;
    const result = await resumeCampaign(campaign.id);
    res.json({ success: true, data: { status: result.status } });
  })
);

router.post(
  "/:id/cancel",
  requireUserCampaign,
  asyncHandler(async (req: Request, res: Response) => {
    const campaign = (req as any).campaign;
    await cancelCampaign(campaign.id);
    res.json({ success: true, data: { status: "CANCELLED" } });
  })
);

/**
 * 8. GET /api/campaigns/:id/drafts?status=&isSample=&cursor=&limit=
 */
router.get(
  "/:id/drafts",
  requireUserCampaign,
  asyncHandler(async (req: Request, res: Response) => {
    const campaign = (req as any).campaign;
    const drafts = await listDrafts(campaign.id, {
      status: req.query.status as any,
      isSample: req.query.isSample !== undefined ? req.query.isSample === "true" : undefined,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
    });

    res.json({ success: true, data: drafts });
  })
);

/**
 * 9. PATCH /api/campaigns/:id/drafts/:draftId
 * body { type: "approve" | "use_plain" } or { type: "edit", aiIntro }
 */
router.patch(
  "/:id/drafts/:draftId",
  requireUserCampaign,
  asyncHandler(async (req: Request, res: Response) => {
    const parse = resolveDraftSchema.safeParse(req.body);
    if (!parse.success) {
      throw parse.error;
    }

    const campaign = (req as any).campaign;
    const draftId = String(req.params.draftId);
    const draft = await prisma.generatedDraft.findUnique({
      where: { id: draftId },
      select: { id: true, campaignId: true },
    });

    if (!draft || draft.campaignId !== campaign.id) {
      res.status(404).json({
        success: false,
        error: {
          code: "DRAFT_NOT_FOUND",
          message: "Draft not found",
        },
      });
      return;
    }

    const result = await resolveDraft(draftId, parse.data);
    res.json({ success: true, data: result });
  })
);

/**
 * 10. POST /api/campaigns/:id/drafts/bulk
 * body { type: "approve" | "use_plain", codes? }
 */
router.post(
  "/:id/drafts/bulk",
  requireUserCampaign,
  asyncHandler(async (req: Request, res: Response) => {
    const parse = bulkResolveSchema.safeParse(req.body);
    if (!parse.success) {
      throw parse.error;
    }

    const campaign = (req as any).campaign;
    const result = await bulkResolve(campaign.id, parse.data);

    res.json({
      success: true,
      data: {
        changed: result.changed,
        skippedHardBlocked: result.skippedHardBlocked,
      },
    });
  })
);

// Terminating error-handling middleware for the router
router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const { status, body } = mapCampaignError(err);
  res.status(status).json(body);
});

export default router;
