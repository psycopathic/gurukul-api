import type { NextFunction, Request, Response } from "express";
import { isBucketId } from "../config/buckets";
import { badRequest, unauthorized } from "../errors";
import { grantPlaybackAccess } from "../services/playback.service";
import {
  getVideoStatus,
  prepareOriginalUpload,
  prepareVideoUpload,
  startVideoProcessing,
} from "../services/video.service";

function videoIdParam(request: Request): string {
  const videoId = request.params.videoId;
  if (typeof videoId !== "string" || !videoId.trim()) {
    throw badRequest("A videoId is required");
  }
  return videoId.trim();
}

/// `GET /api/videos/:videoId/play`
///
/// Authenticated (Firebase ID token) and authorized (per-video rule) playback
/// authorization. Returns a temporary signed R2 URL — never a permanent one —
/// or, for a processed video with nothing playable yet, just its `status`.
export async function getPlaybackAccess(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = request.user;
    if (!user) {
      // Unreachable behind requireAppUser; guards against a future route being
      // wired up without the middleware.
      throw unauthorized("missing_user_context");
    }

    const access = await grantPlaybackAccess(videoIdParam(request), user);

    // Signed URLs are per-user and short-lived; no shared cache may keep them.
    response.setHeader("Cache-Control", "no-store");
    response.json(access);
  } catch (error) {
    next(error);
  }
}

/// `POST /api/videos/upload-url` — operator only.
///
/// **Request validation is disabled for now, deliberately.** Any content type is
/// accepted, and an explicit `key` is signed as given, so this mints a write
/// handle for an arbitrary file at an arbitrary path — including one that is
/// already live. Nothing here inspects what is being uploaded or where it lands.
///
/// The operator token is still required. It is not a check on the file; it is the
/// only thing standing between this endpoint and an open write handle on the
/// bucket, so it stays while the rest is off.
export async function getUploadUrl(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { fileName, contentType, bucket, key } = request.body as {
      fileName?: unknown;
      contentType?: unknown;
      bucket?: unknown;
      key?: unknown;
    };

    // An unregistered bucket falls back to the videos bucket instead of a 400 —
    // it has to resolve to something, since only registered buckets have
    // credentials and a name.
    const target = isBucketId(bucket) ? bucket : "videos";

    response.setHeader("Cache-Control", "no-store");
    response.status(201).json(
      await prepareVideoUpload({
        bucket: target,
        fileName: typeof fileName === "string" ? fileName : undefined,
        contentType: typeof contentType === "string" ? contentType : undefined,
        key: typeof key === "string" ? key : undefined,
      }),
    );
  } catch (error) {
    next(error);
  }
}

/// `POST /api/videos/:videoId/original/upload-url` — operator only.
///
/// Presigned PUT for the video's original. The file goes straight to R2.
export async function getOriginalUploadUrl(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const upload = await prepareOriginalUpload(videoIdParam(request));
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json(upload);
  } catch (error) {
    next(error);
  }
}

/// `POST /api/videos/:videoId/process` — operator only.
///
/// `202 Accepted`: the transcode runs in the background. Poll
/// `GET /api/videos/:videoId/status` for the outcome.
export async function processVideoOriginal(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { sourceKey } = (request.body ?? {}) as { sourceKey?: unknown };
    if (sourceKey !== undefined && typeof sourceKey !== "string") {
      throw badRequest("sourceKey must be a string");
    }

    const record = await startVideoProcessing(videoIdParam(request), { sourceKey });
    response.setHeader("Cache-Control", "no-store");
    response.status(202).json(record);
  } catch (error) {
    next(error);
  }
}

/// `GET /api/videos/:videoId/status` — operator only.
export async function getProcessingStatus(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const record = await getVideoStatus(videoIdParam(request));
    response.setHeader("Cache-Control", "no-store");
    response.json(record);
  } catch (error) {
    next(error);
  }
}
