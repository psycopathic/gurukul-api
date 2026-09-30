/// Registry of the Cloudflare R2 buckets this API is allowed to sign URLs for.
///
/// This is the single place to touch when Gurukul gains another bucket. Add one
/// entry below, add the matching `R2_BUCKET_<ID>` variable to `.env`, and the
/// rest of the API (client pooling, presigning, validation, logging) picks it up
/// with no further changes.
///
/// ```ts
/// audio: {
///   bucketNameEnv: "R2_BUCKET_AUDIO",
///   expirySecondsEnv: "AUDIO_URL_EXPIRATION_SECONDS",
///   defaultExpirySeconds: 3600,
/// },
/// ```
///
/// A bucket may point at a different R2 account by setting `credentialsPrefix`;
/// the shared `R2_*` credentials are used when it is omitted.

export interface BucketDefinition {
  /// Env var holding the real bucket name, so bucket names are never hardcoded.
  readonly bucketNameEnv: string;

  /// Env var overriding how long presigned URLs for this bucket stay valid.
  readonly expirySecondsEnv: string;

  /// Fallback expiry when `expirySecondsEnv` is unset.
  readonly defaultExpirySeconds: number;

  /// Prefix of this bucket's credential env vars — `<PREFIX>_ACCOUNT_ID`,
  /// `<PREFIX>_ACCESS_KEY_ID`, `<PREFIX>_SECRET_ACCESS_KEY`. Defaults to `R2`.
  readonly credentialsPrefix?: string;
}

/// Logical bucket ids used throughout the codebase. Catalog entries and API
/// callers refer to buckets by these ids, never by the real bucket name.
export const BUCKET_DEFINITIONS = {
  videos: {
    bucketNameEnv: "R2_BUCKET_VIDEOS",
    expirySecondsEnv: "VIDEO_URL_EXPIRATION_SECONDS",
    defaultExpirySeconds: 1800,
  },
} as const satisfies Record<string, BucketDefinition>;

export type BucketId = keyof typeof BUCKET_DEFINITIONS;

export const BUCKET_IDS = Object.keys(BUCKET_DEFINITIONS) as BucketId[];

export function isBucketId(value: unknown): value is BucketId {
  return typeof value === "string" && value in BUCKET_DEFINITIONS;
}
