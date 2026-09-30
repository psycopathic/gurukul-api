import { forbidden, notFound } from "../errors";
import type { AppUser } from "../types/app-user";
import type { VideoPlaybackAccess } from "../types/video.types";
import { findVideoById } from "./catalog.service";
import { authorizePlayback } from "./entitlement.service";
import { LogEvent, logger, redactSignedUrl } from "./logger";
import { createDownloadUrl } from "./r2.service";

/// Authorize a user for one video and mint a short-lived R2 URL for it.
///
/// Order matters: look the video up, authorize, *then* sign. A signed URL is
/// never created for a request that would have been refused.
export async function grantPlaybackAccess(
  videoId: string,
  user: AppUser,
): Promise<VideoPlaybackAccess> {
  const video = await findVideoById(videoId);

  if (!video) {
    logger.warn(LogEvent.videoNotFound, { videoId, uid: user.uid });
    throw notFound("video_not_found");
  }

  const decision = authorizePlayback(video, user);

  if (!decision.allowed) {
    logger.warn(LogEvent.playbackAuthorizationDenied, {
      videoId,
      uid: user.uid,
      provider: user.provider,
      reason: decision.reason,
    });
    throw forbidden(decision.reason);
  }

  const signed = await createDownloadUrl(video.bucket, video.objectKey);

  logger.info(LogEvent.playbackAuthorizationGranted, {
    videoId,
    uid: user.uid,
    provider: user.provider,
    reason: decision.reason,
  });
  logger.info(LogEvent.signedUrlGenerated, {
    videoId,
    bucket: video.bucket,
    expiresIn: signed.expiresIn,
    // Host + path only. The signature is stripped, so this line can never be
    // replayed as a working URL.
    target: redactSignedUrl(signed.url),
  });

  return {
    videoId,
    videoUrl: signed.url,
    expiresIn: signed.expiresIn,
    expiresAt: signed.expiresAt,
  };
}
