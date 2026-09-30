import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { BucketId } from "../config/buckets";
import { assertBucketConfigured, bucketConfig } from "../config/env";

/// One S3 client per registered bucket, built lazily so a bucket that is
/// declared but not yet configured only fails when something actually uses it.
const clients = new Map<BucketId, S3Client>();

function clientFor(id: BucketId): S3Client {
  const existing = clients.get(id);
  if (existing) return existing;

  assertBucketConfigured(id);
  const { credentials } = bucketConfig(id);

  // Presigned URLs only work against the S3 API domain — Cloudflare custom
  // domains cannot serve them — so this endpoint is also what the app fetches.
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${credentials.accountId}.r2.cloudflarestorage.com`,
    // Path style keeps the host stable per account (`/<bucket>/<key>`), which
    // makes redacted log lines readable and adding buckets a no-op for DNS.
    forcePathStyle: true,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });

  clients.set(id, client);
  return client;
}

export interface SignedUrl {
  url: string;
  expiresIn: number;
  expiresAt: string;
}

function signedUrlResult(url: string, expiresIn: number): SignedUrl {
  return {
    url,
    expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

/// Read-only GET URL for one object. Only `host` is signed, so the video player
/// is free to add `Range` headers — which is what makes seeking work.
export async function createDownloadUrl(
  bucket: BucketId,
  key: string,
  expiresInOverride?: number,
): Promise<SignedUrl> {
  const config = bucketConfig(bucket);
  const expiresIn = expiresInOverride ?? config.expirySeconds;

  const url = await getSignedUrl(
    clientFor(bucket),
    new GetObjectCommand({ Bucket: config.bucketName, Key: key }),
    { expiresIn },
  );

  return signedUrlResult(url, expiresIn);
}

export async function createUploadUrl(
  bucket: BucketId,
  key: string,
  contentType: string,
): Promise<SignedUrl> {
  const config = bucketConfig(bucket);
  const expiresIn = config.expirySeconds;

  const url = await getSignedUrl(
    clientFor(bucket),
    new PutObjectCommand({
      Bucket: config.bucketName,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn },
  );

  return signedUrlResult(url, expiresIn);
}

/// Test seam: drop cached clients so a changed configuration is picked up.
export function resetR2Clients(): void {
  clients.clear();
}
