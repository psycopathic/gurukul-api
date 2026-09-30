import type { NextFunction, Request, Response } from "express";
import { tooManyRequests } from "../errors";
import { LogEvent, logger } from "../services/logger";

/// Fixed-window counter, in process memory.
///
/// Deliberately dependency-free: the limit exists to stop one client minting
/// unlimited signed URLs, and a single API instance does not justify pulling in
/// Redis. Running more than one instance makes the effective limit
/// `max × instances`, which is still bounded — swap `hits` for a shared store if
/// that ever matters.
interface Window {
  count: number;
  resetAt: number;
}

const hits = new Map<string, Window>();

function take(key: string, max: number, windowMs: number): number {
  const now = Date.now();
  const existing = hits.get(key);

  if (!existing || existing.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return 0;
  }

  existing.count += 1;
  if (existing.count > max) {
    return Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  }
  return 0;
}

/// Evict expired windows so a long-running process does not grow a key per user
/// seen since boot.
function sweep(now: number): void {
  for (const [key, window] of hits) {
    if (window.resetAt <= now) hits.delete(key);
  }
}

let sweptAt = Date.now();

export interface RateLimitOptions {
  max: number;
  windowSeconds: number;
  name: string;
}

/// Limits per user *and* per IP: the user bucket stops one account looping, the
/// IP bucket stops someone cycling throwaway anonymous sessions. Both are sized
/// for real viewing (a handful of refreshes per video), not for a single play.
export function rateLimit(options: RateLimitOptions) {
  const windowMs = options.windowSeconds * 1000;

  return (request: Request, _response: Response, next: NextFunction): void => {
    const now = Date.now();
    if (now - sweptAt > windowMs) {
      sweep(now);
      sweptAt = now;
    }

    const subjects = [
      request.user ? `${options.name}:uid:${request.user.uid}` : undefined,
      `${options.name}:ip:${request.ip ?? "unknown"}`,
    ].filter((value): value is string => value !== undefined);

    for (const subject of subjects) {
      const retryAfter = take(subject, options.max, windowMs);
      if (retryAfter > 0) {
        logger.warn(LogEvent.rateLimited, {
          scope: subject.split(":")[1],
          uid: request.user?.uid,
          path: request.path,
        });
        next(tooManyRequests(retryAfter));
        return;
      }
    }

    next();
  };
}

/// Test seam.
export function resetRateLimits(): void {
  hits.clear();
}
