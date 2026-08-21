import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { authenticate } from "../middleware/auth";

const router = Router();

router.post("/google", async (req: Request, res: Response) => {
  try {
    const { accessToken } = req.body;

    if (!accessToken) {
      res.status(400).json({
        success: false,
        error: "accessToken is required",
      });
      return;
    }

    // Use the access token to fetch user info from Google
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      res.status(401).json({
        success: false,
        error: "Failed to verify Google access token",
      });
      return;
    }

    const payload = (await response.json()) as {
      sub: string;
      email: string;
      name?: string;
      picture?: string;
    };

    if (!payload || !payload.email) {
      res.status(401).json({
        success: false,
        error: "Failed to get user info from Google",
      });
      return;
    }

    // Create user payload for JWT
    const user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name || payload.email,
      avatar: payload.picture,
    };

    // Sign JWT
    const token = jwt.sign(user, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    } as jwt.SignOptions);

    res.json({
      success: true,
      data: { token, user },
    });
  } catch (error: any) {
    console.error("[Auth] Google login error:", error.message);
    res.status(401).json({
      success: false,
      error: "Google authentication failed",
    });
  }
});


router.get("/me", authenticate, (req: Request, res: Response) => {
  res.json({
    success: true,
    data: req.user,
  });
});

export default router;
