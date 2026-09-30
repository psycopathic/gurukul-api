import { Router } from "express";
import { env } from "../config/env";
import {
  getPlaybackAccess,
  getUploadUrl,
} from "../controllers/video.controller";
import { requireAppCheck } from "../middleware/app-check.middleware";
import { requireAppUser, requireOperator } from "../middleware/auth.middleware";
import { rateLimit } from "../middleware/rate-limit.middleware";

export const videoRouter = Router();

/// App-facing playback authorization. Three gates, in order: attest the app,
/// identify the user, then bound the rate. User auth precedes the rate limiter so
/// it can key on the real uid rather than on an unverified header.
videoRouter.get(
  "/:videoId/play",
  requireAppCheck,
  requireAppUser,
  rateLimit({ ...env.playbackRateLimit, name: "playback" }),
  getPlaybackAccess,
);

/// Operator-only content publishing. Not used by the app.
videoRouter.post("/upload-url", requireOperator, getUploadUrl);
