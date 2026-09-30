import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { unauthorized } from "../errors";
import { verifyAppUser } from "../services/firebase.service";
import { LogEvent, logger } from "../services/logger";
import type { AppUser } from "../types/app-user";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /// Populated by [requireAppUser]. Present only on authenticated routes.
      user?: AppUser;
    }
  }
}

function bearerToken(request: Request): string | undefined {
  const header = request.header("authorization");
  if (!header) return undefined;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return undefined;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : undefined;
}

/// App-user authentication: a Firebase ID token from the signed-in Gurukul
/// client. Attaches `request.user` or answers 401.
export async function requireAppUser(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  const token = bearerToken(request);
  if (!token) {
    next(unauthorized("missing_bearer_token"));
    return;
  }

  try {
    request.user = await verifyAppUser(token);
    next();
  } catch (error) {
    logger.warn(LogEvent.authFailed, {
      reason: (error as { reason?: string }).reason ?? "invalid_token",
      path: request.path,
    });
    next(error);
  }
}

/// Operator authentication for the upload endpoints, which publish content and
/// are not used by the app at all. Deliberately a separate, server-side secret:
/// it is never shipped to Flutter.
export function requireOperator(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  if (!env.adminApiToken) {
    next(unauthorized("admin_token_not_configured"));
    return;
  }
  if (bearerToken(request) !== env.adminApiToken) {
    next(unauthorized("invalid_admin_token"));
    return;
  }
  next();
}
