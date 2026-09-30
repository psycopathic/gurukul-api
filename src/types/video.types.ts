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

/// The playback response. Exactly what the player needs and nothing more — no
/// object key, no bucket, no credentials, no authorization internals.
export interface VideoPlaybackAccess {
  videoId: string;
  videoUrl: string;
  expiresIn: number;
  expiresAt: string;
}
