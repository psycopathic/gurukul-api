import { createApp } from "./app";
import { assertStartupConfig, env } from "./config/env";
import { BUCKET_IDS } from "./config/buckets";
import { LogEvent, logger } from "./services/logger";
import { assertTranscoderAvailable } from "./services/transcoder.service";

// Misconfiguration should stop the process, not surface as a 500 on the first
// video a child tries to watch.
assertStartupConfig();

createApp().listen(env.port, () => {
  logger.info(LogEvent.startup, {
    port: env.port,
    nodeEnv: env.nodeEnv,
    buckets: BUCKET_IDS,
  });
});

// Warn, don't exit: playback never needs FFmpeg, only processing does, and
// `POST /process` answers 503 with the same message when it is missing.
assertTranscoderAvailable().catch((error: unknown) => {
  logger.warn(LogEvent.ffmpegUnavailable, {
    message: error instanceof Error ? error.message : String(error),
  });
});
