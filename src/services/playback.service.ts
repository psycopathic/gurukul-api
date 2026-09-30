import { videoObjectKeys } from "../catalog/video-layout";
import { forbidden, notFound } from "../errors";
import type { AppUser } from "../types/app-user";
import type { VideoPlaybackResponse } from "../types/video.types";
import { findVideoById } from "./catalog.service";
import { authorizePlayback } from "./entitlement.service";
import { LogEvent, logger, redactSignedUrl } from "./logger";
import { createDownloadUrl } from "./r2.service";
import { readVideoStatus } from "./video-status.service";

/// Authorize a user for one video and mint a short-lived R2 URL for it.
///
/// Order matters: look the video up, authorize, *then* sign. A signed URL is
/// never created for a request that would have been refused.
///
/// A processed video plays its 720p rendition and nothing else. Until one has
/// been published the answer is its status with no URL — the original is never
/// offered instead, since serving the 21 Mbps master is what processing exists
/// to avoid.
export async function grantPlaybackAccess(
  videoId: string,
  user: AppUser,
): Promise<VideoPlaybackResponse> {
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

  let objectKey = video.objectKey;
  if (objectKey === undefined) {
    const record = await readVideoStatus(video.bucket, video.id);
    if (!record?.rendition) {
      // No status means nothing has been uploaded for this id yet. (`READY`
      // is only ever written together with a rendition, so it cannot get here.)
      const status = record && record.status !== "READY" ? record.status : "UPLOADING";
      logger.info(LogEvent.videoNotReady, { videoId, uid: user.uid, status });
      return { videoId, status };
    }
    objectKey = videoObjectKeys(video.id).playback;
  }

  const signed = await createDownloadUrl(video.bucket, objectKey);

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
    status: "READY",
    videoUrl: signed.url,
    expiresIn: signed.expiresIn,
    expiresAt: signed.expiresAt,
  };
}
