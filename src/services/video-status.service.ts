import type { BucketId } from "../config/buckets";
import { videoObjectKeys } from "../catalog/video-layout";
import type {
  RenditionInfo,
  VideoProcessingStatus,
  VideoStatusRecord,
} from "../types/video.types";
import { objectStore } from "./r2.service";

/// Processing state for a video, kept as `videos/<id>/status.json` beside the
/// video itself. Gurukul has no database, and a small object next to the
/// files it describes survives restarts without adding one. Swap these two
/// functions for a table when the catalog moves to a database.

export async function readVideoStatus(
  bucket: BucketId,
  videoId: string,
): Promise<VideoStatusRecord | undefined> {
  const raw = await objectStore().getText(bucket, videoObjectKeys(videoId).status);
  if (raw === undefined) return undefined;
  return JSON.parse(raw) as VideoStatusRecord;
}

/// Moves a video to `status`, keeping the last published rendition unless a new
/// one is given. A failure reason only survives while the video is `FAILED`.
export async function writeVideoStatus(
  bucket: BucketId,
  videoId: string,
  status: VideoProcessingStatus,
  changes: { failureReason?: string; rendition?: RenditionInfo } = {},
): Promise<VideoStatusRecord> {
  const previous = await readVideoStatus(bucket, videoId);
  const rendition = changes.rendition ?? previous?.rendition;
  const record: VideoStatusRecord = {
    videoId,
    status,
    updatedAt: new Date().toISOString(),
    ...(status === "FAILED" && changes.failureReason
      ? { failureReason: changes.failureReason }
      : {}),
    ...(rendition ? { rendition } : {}),
  };

  await objectStore().putText(
    bucket,
    videoObjectKeys(videoId).status,
    JSON.stringify(record, null, 2),
    "application/json",
  );
  return record;
}
