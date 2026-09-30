import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { HttpError } from "./errors";
import { videoRouter } from "./routes/video.routes";
import { LogEvent, logger } from "./services/logger";

export function createApp() {
  const app = express();

  // Behind Cloudflare/a load balancer, so the rate limiter needs the real
  // client IP rather than the proxy's.
  app.set("trust proxy", true);

  app.use(cors());
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.use("/api/videos", videoRouter);

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  app.use(
    (
      error: unknown,
      request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (error instanceof HttpError) {
        response.status(error.status).json({ error: error.message });
        return;
      }

      // Unexpected: log it server-side, tell the client nothing. An R2 or
      // Firebase error message can name buckets and accounts.
      logger.error(LogEvent.serverError, {
        path: request.path,
        method: request.method,
        message: error instanceof Error ? error.message : String(error),
      });
      response.status(500).json({ error: "Internal server error" });
    },
  );

  return app;
}
