# Gurukul Video API

Express + TypeScript API that authorizes Gurukul video playback and hands the app
a **short-lived Cloudflare R2 presigned URL**. The R2 bucket is private; the app
holds no R2 credentials and never learns a bucket name or object key.

```
Flutter app                                    Cloudflare R2
     │                                        (private bucket)
     │ GET /api/videos/<id>/play                     ▲
     │ Authorization: Bearer <Firebase ID token>     │ signed GET,
     │ X-Firebase-AppCheck: <attestation>            │ expires in 30m
     ▼                                               │
Gurukul Video API ──1. verify App Check (is this our app?) ──┘
                  ──2. verify ID token (who is asking?)
                  ──3. look the video up in the catalog
                  ──4. authorize this user for this video
                  ──5. presign a read-only GET for its object key
```

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | liveness |
| `GET` | `/api/videos/:videoId/play` | App Check + Firebase ID token | playback authorization → signed URL |
| `POST` | `/api/videos/upload-url` | `ADMIN_API_TOKEN` | operator-only: presign an upload (**validation currently off** — see below) |

### `GET /api/videos/:videoId/play`

```http
GET /api/videos/ganesha_elephant_head/play
Authorization: Bearer <firebase-id-token>
X-Firebase-AppCheck: <app-check-token>
```

```json
{
  "videoId": "ganesha_elephant_head",
  "videoUrl": "https://<account>.r2.cloudflarestorage.com/<bucket>/video/...?X-Amz-...",
  "expiresIn": 1800,
  "expiresAt": "2026-09-25T10:30:00.000Z"
}
```

`401` unauthenticated · `403` not allowed to watch this video · `404` no such
video · `429` rate limited. The response carries nothing else — no object key,
no bucket, no credentials, no authorization internals.

## Authentication and authorization

**Watching a story video requires no sign-up.** Gurukul signs every user in
anonymously at splash; signing in with Google or Apple exists only to save a
child's progress, and never gates content. The catalog ships every video as
`{ kind: "authenticated" }`, which accepts those anonymous sessions, and a test
pins that (`test/playback.test.ts`, "the shipped catalog") so it cannot drift.

Authentication reuses that existing Firebase Auth session: the client sends the ID
token it already has, and the API verifies it with the Admin SDK
(`checkRevoked: true`, so a signed-out or disabled user stops working at once).
There is no second login system and no client-held API key.

Be clear-eyed about what that identity proves. The Firebase Web API key ships
inside the app, so anyone can call `accounts:signUp` against it and get a valid
anonymous ID token — that is exactly how the local-testing recipe below mints one.
A verified token therefore means "an identity from the Gurukul Firebase project",
not "a real person" and not "the real Gurukul app". Proving it *is* the app is a
separate layer — see *App Check* below.

Authorization is separate and always server-side. Every video in
`src/catalog/video-catalog.ts` carries an access rule:

| Rule | Who may watch |
| --- | --- |
| `{ kind: "authenticated" }` | any signed-in client, including Gurukul's default anonymous session — **what every story video uses today** |
| `{ kind: "account" }` | a linked Google/Apple account only. Unused: it would put a sign-in wall in front of a story |
| `{ kind: "entitlement", anyOf: [...] }` | a user whose ID token carries one of these slugs in its `entitlements` custom claim. Unused |

The last two exist as the seam for any future paid or age-restricted content:
grant the claim server-side (`setCustomUserClaims`) wherever that decision is
made. The client never participates in the decision.

## Adding a video

1. `POST /api/videos/upload-url` with the operator token, then `PUT` the file to
   the URL it returns.
2. Add an entry to `src/catalog/video-catalog.ts` with the returned `key` and an
   access rule.
3. Add the story id to the app's `assets/data/video.json` so the app shows a
   player.

Pass `key` to choose the object key yourself and skip step 2 — it is signed
verbatim, so it can replace a video that is already live:

```http
POST /api/videos/upload-url
Authorization: Bearer <admin-api-token>

{ "key": "video/ganesha_elephant_head.mp4", "contentType": "video/mp4" }
```

### Upload validation is off

`POST /api/videos/upload-url` currently validates nothing about the file:

| Was | Now |
| --- | --- |
| `contentType` required, had to be `video/*` | optional, anything; defaults to `application/octet-stream` |
| `fileName` required | optional, only used to derive an extension |
| key always generated as `video/<uuid><ext>` | an explicit `key` is signed verbatim, and may overwrite a live object |
| unregistered `bucket` → `400` | falls back to the `videos` bucket |

This is temporary, to publish arbitrary files. `ADMIN_API_TOKEN` is still
required and should stay that way while the rest is off — it is the only thing
between this endpoint and an open write handle on the bucket. Three tests in
`test/playback.test.ts` pin the loosened behaviour, so restoring the checks will
fail there rather than change behaviour silently.

## Adding a bucket

`src/config/buckets.ts` is the only file to touch. Add an entry:

```ts
audio: {
  bucketNameEnv: "R2_BUCKET_AUDIO",
  expirySecondsEnv: "AUDIO_URL_EXPIRATION_SECONDS",
  defaultExpirySeconds: 3600,
},
```

then set `R2_BUCKET_AUDIO` in `.env`. Client pooling, presigning, request
validation, startup checks and logging all pick it up. Catalog entries refer to
it by its logical id (`bucket: "audio"`), never by the real bucket name. A bucket
in a different R2 account sets `credentialsPrefix` and gets its own
`<PREFIX>_ACCOUNT_ID` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` variables.

## Cloudflare R2 setup

- **Bucket:** private. No public r2.dev access, no public custom domain for it.
- **Credentials:** an R2 API token scoped to *read* the video bucket is enough
  for playback. Add write only if this instance also serves upload URLs.
- **Endpoint:** presigned URLs only work on the S3 API domain
  (`https://<account>.r2.cloudflarestorage.com`) — Cloudflare custom domains
  cannot serve them. Requests are path-style, so one host serves every bucket.
- **CORS:** not needed for the Android/iOS players, which are native and not
  subject to CORS. Flutter **web** would need a CORS rule on the bucket allowing
  `GET`/`HEAD` and the `Range` request header from the app's origin.
- **Range requests:** only `host` is signed, so the player is free to send
  `Range` headers. Seeking, buffering and resume work against a presigned URL.
- **Expiry:** R2 allows 1s–7d. `VIDEO_URL_EXPIRATION_SECONDS` defaults to 1800.

## App Check: proving the request came from the app

Verifying an ID token answers *who* is asking. It cannot answer *what* is asking,
because the API key that mints those tokens ships inside the app. App Check
answers the second question: `requireAppCheck`
(`src/middleware/app-check.middleware.ts`) verifies an `X-Firebase-AppCheck`
header before user authentication runs.

Why a header the client declares itself could never do this job: a package name
like `com.voicegames.gurukul` is printed on the Play Store listing, so
`curl -H "X-App-Package: com.voicegames.gurukul"` would pass. An App Check
attestation is signed **on-device** — by Play Integrity, bound to the package name
*and* the release signing certificate, or by Apple App Attest, bound to a hardware
key and the bundle id. Nothing shipped in the binary can produce one, so it cannot
be lifted out of an APK.

**This attests the app, not the user.** An anonymous session is attested exactly
like a linked account, so story videos stay watchable without signing up. Tests
pin both halves of that: `test/app-check.test.ts` asserts a genuine build with an
anonymous session gets a `200` while an unattested caller holding a valid
anonymous token gets `401`.

### Rolling it out

`APP_CHECK_ENFORCED` defaults to `false`, and the default is the point:

| Mode | Behaviour |
| --- | --- |
| `false` (default) | verify, log the outcome, **serve either way** |
| `true` | missing or invalid attestation → `401` |

Run unenforced first and watch for `app_check_verified` in the logs from real
devices; `app_check_token_missing` and `app_check_token_invalid` tell you who
would have been refused. Flip the flag only once that looks right — a Play
Integrity misconfiguration in enforced mode breaks video for real children.

### Console setup

1. Firebase Console → **App Check** → register the Android app with the **Play
   Integrity** provider and the iOS app with **App Attest**.
2. Android requires the app to be distributed through Play; an internal testing
   track is enough. Link the Play app under Project settings → Integrations.
3. iOS App Attest needs a physical device and the App Attest capability.
4. Debug builds use the debug provider and print a token on first launch. Register
   it under App Check → *Manage debug tokens*, or that build will log as
   unattested (harmless while unenforced).

### Limits

App Check raises the bar a great deal but is not absolute: a rooted device or a
hooked debug build can still produce valid attestations. It stops casual, scripted
access — the realistic threat here — not a determined attacker. And it controls who
can **obtain** a signed URL, never who can **use** one: R2 serves a valid signed
URL to any HTTP client, so a leaked URL still works for its lifetime. Shortening
`VIDEO_URL_EXPIRATION_SECONDS` is the lever for that.

## Rate limiting

`GET /:videoId/play` is limited per authenticated user *and* per IP —
`PLAYBACK_RATE_LIMIT_MAX` grants per `PLAYBACK_RATE_LIMIT_WINDOW_SECONDS`
(default 30/minute). Watching a video costs one grant plus the occasional
refresh, so the limit is invisible in normal use while bounding how fast anyone
can harvest URLs. The counter is in process memory and deliberately dependency-
free; with N instances the effective limit is `max × N`, still bounded. Swap the
map in `src/middleware/rate-limit.middleware.ts` for a shared store if that
becomes the binding constraint.

## Logging

One JSON line per event, via `src/services/logger.ts`:
`video_playback_authorization_granted`, `video_playback_authorization_denied`,
`video_not_found`, `video_signed_url_generated`, `video_playback_rate_limited`,
`auth_token_rejected`, `app_check_verified`, `app_check_token_missing`,
`app_check_token_invalid`, `unhandled_error`. Signed URLs are logged as host + path
only — every `X-Amz-*` parameter, the signature included, is stripped — and any
field whose name looks like a secret is redacted.

## What this does and does not protect

What it stops: **permanent public URLs, anonymous access to the bucket, bucket
enumeration, and easy URL sharing.** Playback URLs expire, access is revocable
without renaming objects, every grant is rate limited per user and per IP, and
every decision is logged and attributable. Those are the wins over a public
`r2.dev` URL, and they hold.

What it does not stop:

- **A caller that is not the Gurukul app** — unless App Check is enforced; see
  below. Until then, an anonymous ID token is free to mint with the API key
  shipped in the app, so a script can request playback just as the app can.
- **An authorized viewer keeping the video.** This is not DRM. They can
  screen-record, download the file while their URL is valid, or pass that URL to
  someone else for the minutes it lives. Shortening
  `VIDEO_URL_EXPIRATION_SECONDS` narrows the window; it does not close it.
  High-value premium content would need a packaged-streaming/DRM setup, evaluated
  separately.

## Setup

```bash
cp .env.example .env   # fill in Firebase + R2 values
npm install
npm run dev            # http://localhost:3000
```

`npm run typecheck` · `npm test` · `npm run build` · `npm start`.

The process refuses to start if `FIREBASE_PROJECT_ID` or any registered bucket's
variables are missing, so misconfiguration surfaces at deploy time rather than as
a failed video.

### Testing it locally

Mint an anonymous ID token the way the app does — no sign-up, no Google/Apple.
`<web-api-key>` is `client[0].api_key[0].current_key` in the app's
`android/app/google-services.json`:

```bash
TOKEN=$(curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=<web-api-key>" \
  -H 'Content-Type: application/json' -d '{"returnSecureToken":true}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["idToken"])')

curl -s -H "Authorization: Bearer $TOKEN" \
  localhost:3000/api/videos/ganesha_elephant_head/play | python3 -m json.tool
```

That anonymous request returning `200` *is* the intended product behaviour, not a
hole in it. Then confirm the signed URL serves range requests, which is what makes
seeking work:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -r 0-1023 "<videoUrl>"   # expect 206
```

Negative checks: drop the header → `401`; `no_such_video` → `404`; loop past
`PLAYBACK_RATE_LIMIT_MAX` → `429`.
