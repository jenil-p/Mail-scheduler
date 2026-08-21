import { Router, Request, Response } from "express";
import { prisma } from "../db/pool";
import { authenticate } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, async (req: Request, res: Response) => {
  try {
    const userEmail = req.user!.email;
    const status = req.query.status as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    const where: any = { userId: userEmail };
    if (status && ["pending", "sent", "failed", "rate_limited"].includes(status)) {
      where.status = status;
    }

    const [jobs, total] = await Promise.all([
      prisma.emailJob.findMany({
        where,
        orderBy: { scheduledAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.emailJob.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        jobs,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error: any) {
    console.error("[Jobs] Error:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to fetch jobs",
    });
  }
});


router.get("/stats", authenticate, async (req: Request, res: Response) => {
  try {
    const userEmail = req.user!.email;

    const [pending, sent, failed, rateLimited] = await Promise.all([
      prisma.emailJob.count({ where: { userId: userEmail, status: "pending" } }),
      prisma.emailJob.count({ where: { userId: userEmail, status: "sent" } }),
      prisma.emailJob.count({ where: { userId: userEmail, status: "failed" } }),
      prisma.emailJob.count({ where: { userId: userEmail, status: "rate_limited" } }),
    ]);

    res.json({
      success: true,
      data: {
        pending,
        sent,
        failed,
        rateLimited,
        total: pending + sent + failed + rateLimited,
      },
    });
  } catch (error: any) {
    console.error("[Stats] Error:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to fetch stats",
    });
  }
});

export default router;
