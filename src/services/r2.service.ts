import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
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

/// Server-side object operations, used by video processing. Unlike presigning,
/// these talk to R2, so they sit behind [setObjectStore] for tests.
///
/// Objects are streamed to and from disk, never buffered: an original can be
/// hundreds of megabytes.
export interface ObjectStore {
  exists(bucket: BucketId, key: string): Promise<boolean>;

  /// Streams an object into `filePath`. Returns the bytes written.
  downloadToFile(bucket: BucketId, key: string, filePath: string): Promise<number>;

  uploadFile(
    bucket: BucketId,
    key: string,
    filePath: string,
    contentType: string,
  ): Promise<void>;

  /// A small text object, or `undefined` when there is none.
  getText(bucket: BucketId, key: string): Promise<string | undefined>;

  putText(bucket: BucketId, key: string, body: string, contentType: string): Promise<void>;

  /// Server-side copy within one bucket. Nothing passes through this process.
  copy(bucket: BucketId, fromKey: string, toKey: string): Promise<void>;
}

function isNotFound(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.name === "NoSuchKey" ||
    candidate.name === "NotFound" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

const r2ObjectStore: ObjectStore = {
  async exists(bucket, key) {
    try {
      await clientFor(bucket).send(
        new HeadObjectCommand({ Bucket: bucketConfig(bucket).bucketName, Key: key }),
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  },

  async downloadToFile(bucket, key, filePath) {
    const response = await clientFor(bucket).send(
      new GetObjectCommand({ Bucket: bucketConfig(bucket).bucketName, Key: key }),
    );
    if (!(response.Body instanceof Readable)) {
      throw new Error(`R2 returned no readable body for ${key}`);
    }
    await pipeline(response.Body, createWriteStream(filePath));
    return (await stat(filePath)).size;
  },

  async uploadFile(bucket, key, filePath, contentType) {
    // A stream body needs an explicit length; without it the SDK cannot sign
    // the request. Single-part PUT caps the file at 5 GiB, far above a 720p
    // rendition of anything Gurukul publishes.
    const { size } = await stat(filePath);
    await clientFor(bucket).send(
      new PutObjectCommand({
        Bucket: bucketConfig(bucket).bucketName,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
  },

  async getText(bucket, key) {
    try {
      const response = await clientFor(bucket).send(
        new GetObjectCommand({ Bucket: bucketConfig(bucket).bucketName, Key: key }),
      );
      return await response.Body?.transformToString("utf-8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  },

  async putText(bucket, key, body, contentType) {
    await clientFor(bucket).send(
      new PutObjectCommand({
        Bucket: bucketConfig(bucket).bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  },

  async copy(bucket, fromKey, toKey) {
    const { bucketName } = bucketConfig(bucket);
    await clientFor(bucket).send(
      new CopyObjectCommand({
        Bucket: bucketName,
        Key: toKey,
        CopySource: `${bucketName}/${fromKey.split("/").map(encodeURIComponent).join("/")}`,
      }),
    );
  },
};

let activeStore: ObjectStore = r2ObjectStore;

/// Test seam: swap R2 for a local fake. `undefined` restores R2.
export function setObjectStore(next: ObjectStore | undefined): void {
  activeStore = next ?? r2ObjectStore;
}

export function objectStore(): ObjectStore {
  return activeStore;
}

/// Test seam: drop cached clients so a changed configuration is picked up.
export function resetR2Clients(): void {
  clients.clear();
}
