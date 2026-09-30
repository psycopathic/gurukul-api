import type { BucketId } from "../config/buckets";

/// Which authenticated users may watch a video.
///
///  * `authenticated` — any signed-in Gurukul client, anonymous sessions
///    included. Gurukul signs every user in anonymously at splash, so this is
///    the rule for the free story library.
///  * `account` — a linked Google/Apple account. Anonymous sessions are denied.
///  * `entitlement` — the user's ID token must carry one of the listed slugs in
///    its `entitlements` custom claim. This is the seam a purchase, enrollment
///    or subscription check plugs into.
export type AccessRule =
  | { readonly kind: "authenticated" }
  | { readonly kind: "account" }
  | { readonly kind: "entitlement"; readonly anyOf: readonly string[] };

export interface VideoRecord {
  /// Stable public id. Matches the story id in the app's `assets/data/video.json`
  /// so the client already knows it and no mapping table is needed.
  readonly id: string;

  /// Logical bucket from `config/buckets.ts` — not a bucket name.
  readonly bucket: BucketId;

  /// Legacy: a single pre-encoded object, served exactly as uploaded. Internal:
  /// never returned to the client.
  ///
  /// Leave it out for a processed video. Those live under `videos/<id>/` (see
  /// `video-layout.ts`) and play the 720p rendition once processing is done.
  /// Moving a legacy video over is `POST /api/videos/<id>/process` with
  /// `{ "sourceKey": "<its objectKey>" }`, then deleting this field once the
  /// status reads `READY`.
  readonly objectKey?: string;

  readonly access: AccessRule;
}

/// The video catalog.
///
/// Kept as code for now because Gurukul's content lives in versioned asset
/// files rather than a database. `catalog.service.ts` is the only reader, so
/// swapping this array for a database query later touches one function.
export const VIDEO_CATALOG: readonly VideoRecord[] = [
  {
    id: "ganesha_elephant_head",
    bucket: "videos",
    access: { kind: "authenticated" },
  },
];
