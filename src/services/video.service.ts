import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CreateUploadUrlInput, PresignedUpload } from "../types/video.types";
import { createUploadUrl } from "./r2.service";

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
