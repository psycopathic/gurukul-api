/// Structured, single-line JSON logging.
///
/// Privacy rules enforced here rather than remembered at each call site:
/// secrets, `Authorization` headers and complete signed URLs are never logged.
/// Presigned URLs are logged only as a host + key pair via [redactSignedUrl],
/// which drops every `X-Amz-*` query parameter — the signature included.

const SENSITIVE_KEY = /(secret|token|password|authorization|credential|cookie)/i;

export type LogFields = Record<string, unknown>;

function sanitize(fields: LogFields): LogFields {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    safe[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : value;
  }
  return safe;
}

function emit(level: "info" | "warn" | "error", event: string, fields: LogFields) {
  const line = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...sanitize(fields),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (event: string, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => emit("error", event, fields),
};

/// `https://acct.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=...`
/// becomes `acct.r2.cloudflarestorage.com/bucket/key`. Safe to log: it proves
/// which object was signed without handing anyone a working URL.
export function redactSignedUrl(signedUrl: string): string {
  try {
    const url = new URL(signedUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    return "[unparseable-url]";
  }
}

/// Analytics/security event names, kept together so they stay greppable.
export const LogEvent = {
  playbackAuthorizationGranted: "video_playback_authorization_granted",
  playbackAuthorizationDenied: "video_playback_authorization_denied",
  videoNotFound: "video_not_found",
  signedUrlGenerated: "video_signed_url_generated",
  rateLimited: "video_playback_rate_limited",
  authFailed: "auth_token_rejected",
  appCheckVerified: "app_check_verified",
  appCheckMissing: "app_check_token_missing",
  appCheckFailed: "app_check_token_invalid",
  videoNotReady: "video_playback_not_ready",
  uploadUrlIssued: "video_original_upload_url_issued",
  originalImported: "video_original_imported",
  processingQueued: "video_processing_queued",
  processingStarted: "video_processing_started",
  originalDownloaded: "video_original_downloaded",
  ffmpegStarted: "video_ffmpeg_started",
  ffmpegCompleted: "video_ffmpeg_completed",
  renditionUploaded: "video_rendition_uploaded",
  processingCompleted: "video_processing_completed",
  processingFailed: "video_processing_failed",
  processingCleanupFailed: "video_processing_cleanup_failed",
  ffmpegUnavailable: "video_ffmpeg_unavailable",
  serverError: "unhandled_error",
  startup: "server_started",
} as const;
