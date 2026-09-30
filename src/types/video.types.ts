import type { BucketId } from "../config/buckets";

export interface CreateUploadUrlInput {
  bucket: BucketId;

  /// Only used to derive an extension when no `key` is given.
  fileName?: string;

  /// Signed as given; defaults to `application/octet-stream`. Not restricted to
  /// `video/*` — upload validation is off for now.
  contentType?: string;

  /// Exact object key. Signed verbatim, so it can replace a live object. Without
  /// it a `video/<uuid><ext>` key is generated.
  key?: string;
}

export interface PresignedUpload {
  bucket: BucketId;
  key: string;
  uploadUrl: string;
  expiresIn: number;
  expiresAt: string;
}

/// Where a processed video is in its lifecycle.
///
///  * `UPLOADING`  — an upload URL was issued; the original may not be in R2 yet.
///  * `PROCESSING` — the original is being transcoded.
///  * `READY`      — the 720p rendition is published and playable.
///  * `FAILED`     — the last processing attempt failed. The original is kept.
export type VideoProcessingStatus = "UPLOADING" | "PROCESSING" | "READY" | "FAILED";

/// What `ffprobe` reported for a published rendition.
export interface RenditionInfo {
  width: number;
  height: number;
  durationSeconds: number;
  sizeBytes: number;
  /// Overall bits per second, audio included.
  bitRate: number;
  publishedAt: string;
}

/// Persisted as `videos/<id>/status.json`. Operator-facing only.
export interface VideoStatusRecord {
  videoId: string;
  status: VideoProcessingStatus;
  updatedAt: string;

  /// Machine-readable stage that failed, e.g. `transcode_failed`. Details are in
  /// the server logs, never here.
  failureReason?: string;

  /// The last rendition that was published successfully. Deliberately outlives
  /// a later re-upload or a failed reprocess: the old 720p file is still in R2
  /// and still correct, so the video stays playable while it is being replaced.
  rendition?: RenditionInfo;
}

/// The playback response. Exactly what the player needs and nothing more — no
/// object key, no bucket, no credentials, no authorization internals.
export interface VideoPlaybackAccess {
  videoId: string;
  status: "READY";
  videoUrl: string;
  expiresIn: number;
  expiresAt: string;
}

/// The playback response for a video with nothing playable yet. Carries no URL:
/// the original is never offered in place of the rendition.
export interface VideoPlaybackPending {
  videoId: string;
  status: Exclude<VideoProcessingStatus, "READY">;
}

export type VideoPlaybackResponse = VideoPlaybackAccess | VideoPlaybackPending;
