import { createApp } from "./app";
import { assertStartupConfig, env } from "./config/env";
import { BUCKET_IDS } from "./config/buckets";
import { LogEvent, logger } from "./services/logger";

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
