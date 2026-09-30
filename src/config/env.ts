import os from "node:os";
import dotenv from "dotenv";
import {
  BUCKET_DEFINITIONS,
  BUCKET_IDS,
  type BucketDefinition,
  type BucketId,
} from "./buckets";

dotenv.config();

/// R2 credentials never leave the server. They are read here and nowhere else,
/// and no route ever echoes them back.
export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface BucketConfig {
  id: BucketId;
  bucketName: string;
  expirySeconds: number;
  credentials: R2Credentials;
}

function requireInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

const parsedPort = requireInt("PORT", 3000, 65535);

/// R2 caps presigned URL lifetimes at 7 days.
const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

function credentialsFor(definition: BucketDefinition): R2Credentials {
  const prefix = definition.credentialsPrefix ?? "R2";
  return {
    accountId: process.env[`${prefix}_ACCOUNT_ID`] ?? "",
    accessKeyId: process.env[`${prefix}_ACCESS_KEY_ID`] ?? "",
    secretAccessKey: process.env[`${prefix}_SECRET_ACCESS_KEY`] ?? "",
  };
}

function bucketConfigFor(id: BucketId): BucketConfig {
  const definition: BucketDefinition = BUCKET_DEFINITIONS[id];
  return {
    id,
    bucketName: process.env[definition.bucketNameEnv] ?? "",
    expirySeconds: requireInt(
      definition.expirySecondsEnv,
      definition.defaultExpirySeconds,
      MAX_EXPIRY_SECONDS,
    ),
    credentials: credentialsFor(definition),
  };
}

const bucketConfigs = Object.fromEntries(
  BUCKET_IDS.map((id) => [id, bucketConfigFor(id)]),
) as Record<BucketId, BucketConfig>;

export const env = {
  port: parsedPort,
  nodeEnv: process.env.NODE_ENV ?? "development",

  /// Firebase project the app's ID tokens are issued by. Required — the API
  /// refuses to authenticate anyone without it.
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? "",

  /// Service-account JSON for the Firebase Admin SDK, either inline or as a
  /// file path. Empty means fall back to `GOOGLE_APPLICATION_CREDENTIALS` /
  /// workload identity, which is how managed hosts supply it.
  firebaseServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? "",
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? "",

  /// Require Firebase App Check attestation on playback requests. Off by
  /// default: roll out unenforced, confirm real devices attest in the logs, then
  /// turn it on. Attestation is about the *app*, never the user — it does not
  /// gate anonymous sessions.
  appCheckEnforced: (process.env.APP_CHECK_ENFORCED ?? "").toLowerCase() === "true",

  /// Shared secret for the operator-only upload endpoints. Not an app user
  /// credential and never shipped to Flutter.
  adminApiToken: process.env.ADMIN_API_TOKEN ?? process.env.API_TOKEN ?? "",

  /// Playback authorization limit, per authenticated user and per IP.
  playbackRateLimit: {
    max: requireInt("PLAYBACK_RATE_LIMIT_MAX", 30, 10000),
    windowSeconds: requireInt("PLAYBACK_RATE_LIMIT_WINDOW_SECONDS", 60, 86400),
  },

  /// Server-side transcoding of uploaded originals into the playback MP4. Only
  /// instances that run processing jobs need FFmpeg installed; playback does not.
  videoProcessing: {
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH?.trim() || "ffprobe",

    /// Scratch space for one original plus its encode, deleted after every job.
    /// Point it at real disk where `/tmp` is a RAM-backed tmpfs.
    tmpDir: process.env.VIDEO_PROCESSING_TMP_DIR?.trim() || os.tmpdir(),
  },

  buckets: bucketConfigs,
} as const;

export function bucketConfig(id: BucketId): BucketConfig {
  return env.buckets[id];
}

/// Fail loudly, at startup, for a bucket that is registered but unconfigured —
/// better than a 500 on the first playback request.
export function assertBucketConfigured(id: BucketId): void {
  const config = env.buckets[id];
  const definition: BucketDefinition = BUCKET_DEFINITIONS[id];
  const prefix = definition.credentialsPrefix ?? "R2";
  const missing = [
    [definition.bucketNameEnv, config.bucketName],
    [`${prefix}_ACCOUNT_ID`, config.credentials.accountId],
    [`${prefix}_ACCESS_KEY_ID`, config.credentials.accessKeyId],
    [`${prefix}_SECRET_ACCESS_KEY`, config.credentials.secretAccessKey],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(
      `Bucket "${id}" is missing environment variables: ${missing
        .map(([name]) => name)
        .join(", ")}`,
    );
  }
}

export function assertStartupConfig(): void {
  if (!env.firebaseProjectId) {
    throw new Error("FIREBASE_PROJECT_ID is required to verify app ID tokens");
  }
  for (const id of BUCKET_IDS) assertBucketConfigured(id);
}
