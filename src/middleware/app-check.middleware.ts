import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { unauthorized } from "../errors";
import { verifyAppCheckToken } from "../services/app-check.service";
import { LogEvent, logger } from "../services/logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /// Set when App Check verified this request. Absent means unattested —
      /// which is allowed while `APP_CHECK_ENFORCED` is off.
      attestedAppId?: string;
    }
  }
}

/// Requires proof that the request came from a genuine Gurukul build.
///
/// Sits *before* user authentication: "is this our app" is a cheaper and broader
/// question than "who is this user", and it is the one that stops a script
/// holding a self-minted anonymous token.
///
/// Two modes, because a Play Integrity misconfiguration must not be able to
/// break video playback for a child mid-story:
///
///  * **unenforced** (default) — verify, log the outcome, and continue either
///    way. Run here until the logs show real devices attesting successfully.
///  * **enforced** (`APP_CHECK_ENFORCED=true`) — a missing or invalid token is
///    a 401.
///
/// Note what this deliberately does *not* do: it never looks at the user. An
/// anonymous session is attested exactly like a linked account, so story videos
/// stay watchable without signing up.
export async function requireAppCheck(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  const token = request.header("x-firebase-appcheck");
  const enforced = env.appCheckEnforced;

  if (!token) {
    logger.warn(LogEvent.appCheckMissing, {
      path: request.path,
      enforced,
    });
    next(enforced ? unauthorized("app_check_token_missing") : undefined);
    return;
  }

  try {
    const { appId } = await verifyAppCheckToken(token);
    request.attestedAppId = appId;
    logger.info(LogEvent.appCheckVerified, { appId, path: request.path });
    next();
  } catch (error) {
    logger.warn(LogEvent.appCheckFailed, {
      path: request.path,
      enforced,
      reason: (error as { reason?: string }).reason ?? "invalid_app_check_token",
    });
    next(enforced ? error : undefined);
  }
}
