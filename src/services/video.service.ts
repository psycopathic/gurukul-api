import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BucketId } from "../config/buckets";
import { isValidVideoId, videoObjectKeys } from "../catalog/video-layout";
import { badRequest, conflict, notFound, serviceUnavailable } from "../errors";
import type {
  CreateUploadUrlInput,
  PresignedUpload,
  VideoStatusRecord,
} from "../types/video.types";
import { findVideoById } from "./catalog.service";
import { LogEvent, logger } from "./logger";
import {
  enqueueVideoProcessing,
  isVideoProcessingQueued,
} from "./processing-queue.service";
import { createUploadUrl, objectStore } from "./r2.service";
import { TranscoderError, assertTranscoderAvailable } from "./transcoder.service";
import { readVideoStatus, writeVideoStatus } from "./video-status.service";

/// Operator-only: mint an upload URL for an object. The returned key is what
/// goes into `catalog/video-catalog.ts` alongside its access rule.
///
/// **File validation is off for now** (see `getUploadUrl`): any content type is
/// accepted, and an explicit `key` is signed as given — which means it can
/// replace an object that is already live. Restore the checks before this
/// endpoint is reachable by anything but an operator.
export async function prepareVideoUpload(
  input: CreateUploadUrlInput,
): Promise<PresignedUpload> {
  const key = uploadKey(input);
  const contentType = input.contentType ?? "application/octet-stream";
  const signed = await createUploadUrl(input.bucket, key, contentType);

  return {
    bucket: input.bucket,
    key,
    uploadUrl: signed.url,
    expiresIn: signed.expiresIn,
    expiresAt: signed.expiresAt,
  };
}

/// An explicit key wins, so an existing object can be replaced in place. Leading
/// slashes are dropped because R2 would otherwise create an empty-named prefix.
/// With no key the generated one keeps the previous behaviour.
function uploadKey(input: CreateUploadUrlInput): string {
  const explicit = input.key?.trim().replace(/^\/+/, "");
  if (explicit) return explicit;

  const extension = path.extname(input.fileName ?? "").toLowerCase();
  return `video/${randomUUID()}${extension}`;
}

// --- Processed videos --------------------------------------------------------
//
// Publishing a processed video is two operator calls, and the original never
// passes through this API:
//
//   1. POST /api/videos/<id>/original/upload-url  → PUT the file straight to R2
//   2. POST /api/videos/<id>/process              → 202; transcoding runs in the
//                                                   background
//
// Then GET /api/videos/<id>/status until it reads READY, and add the id to the
// catalog (without an `objectKey`) so the app can play it.

function requireVideoId(videoId: string): string {
  if (!isValidVideoId(videoId)) {
    throw badRequest(
      "videoId must be 1-128 letters, digits, '_' or '-', starting with a letter or digit",
    );
  }
  return videoId;
}

/// The catalog decides a video's bucket; one not catalogued yet — the normal
/// case while it is being published — goes to the videos bucket.
async function bucketFor(videoId: string): Promise<BucketId> {
  return (await findVideoById(videoId))?.bucket ?? "videos";
}

function assertNotProcessing(videoId: string): void {
  if (isVideoProcessingQueued(videoId)) {
    throw conflict("This video is already being processed. Wait for it to finish.");
  }
}

/// Presigned PUT for `videos/<id>/original.mp4`, and marks the video
/// `UPLOADING`. A video that is already published keeps playing its current
/// rendition until the new upload has been processed.
export async function prepareOriginalUpload(videoId: string): Promise<PresignedUpload> {
  requireVideoId(videoId);
  assertNotProcessing(videoId);

  const bucket = await bucketFor(videoId);
  const key = videoObjectKeys(videoId).original;
  const signed = await createUploadUrl(bucket, key, "video/mp4");
  await writeVideoStatus(bucket, videoId, "UPLOADING");

  logger.info(LogEvent.uploadUrlIssued, { videoId, bucket, key });
  return {
    bucket,
    key,
    uploadUrl: signed.url,
    expiresIn: signed.expiresIn,
    expiresAt: signed.expiresAt,
  };
}

/// Queues the original for transcoding and returns straight away.
///
/// `sourceKey` moves a video uploaded under some other key — a legacy catalog
/// entry's `objectKey` — into place first, as a server-side copy inside R2. The
/// source is left where it is.
export async function startVideoProcessing(
  videoId: string,
  options: { sourceKey?: string } = {},
): Promise<VideoStatusRecord> {
  requireVideoId(videoId);
  assertNotProcessing(videoId);

  try {
    await assertTranscoderAvailable();
  } catch (error) {
    if (!(error instanceof TranscoderError)) throw error;
    logger.error(LogEvent.ffmpegUnavailable, { videoId, message: error.message });
    throw serviceUnavailable(error.message);
  }

  const bucket = await bucketFor(videoId);
  const keys = videoObjectKeys(videoId);
  const sourceKey = options.sourceKey?.trim().replace(/^\/+/, "");

  if (sourceKey && sourceKey !== keys.original) {
    if (!(await objectStore().exists(bucket, sourceKey))) {
      throw badRequest("sourceKey does not exist in the bucket");
    }
    await objectStore().copy(bucket, sourceKey, keys.original);
    logger.info(LogEvent.originalImported, { videoId, from: sourceKey, to: keys.original });
  } else if (!(await objectStore().exists(bucket, keys.original))) {
    throw conflict(`No original uploaded yet. PUT it to ${keys.original} first.`);
  }

  const record = await writeVideoStatus(bucket, videoId, "PROCESSING");
  if (!enqueueVideoProcessing({ videoId, bucket })) {
    // Lost a race with a concurrent request for the same video.
    throw conflict("This video is already being processed. Wait for it to finish.");
  }
  return record;
}

export async function getVideoStatus(videoId: string): Promise<VideoStatusRecord> {
  requireVideoId(videoId);
  const record = await readVideoStatus(await bucketFor(videoId), videoId);
  if (!record) throw notFound("video_status_not_found");
  return record;
}
