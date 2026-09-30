import type { AccessRule, VideoRecord } from "../catalog/video-catalog";
import type { AppUser } from "../types/app-user";

export interface AuthorizationResult {
  allowed: boolean;

  /// Short machine-readable reason, logged on both outcomes. Not user-facing.
  reason: string;
}

function evaluate(rule: AccessRule, user: AppUser): AuthorizationResult {
  switch (rule.kind) {
    case "authenticated":
      return { allowed: true, reason: "free_library" };

    case "account":
      return user.isAnonymous
        ? { allowed: false, reason: "account_required" }
        : { allowed: true, reason: "linked_account" };

    case "entitlement": {
      const match = rule.anyOf.find((slug) => user.entitlements.includes(slug));
      return match
        ? { allowed: true, reason: `entitlement:${match}` }
        : { allowed: false, reason: "entitlement_missing" };
    }
  }
}

/// Server-side authorization. Authentication alone never grants playback: every
/// request is checked against the video's own rule, and the client has no say in
/// the outcome.
export function authorizePlayback(
  video: VideoRecord,
  user: AppUser,
): AuthorizationResult {
  return evaluate(video.access, user);
}
