import {
  getAppCheck,
  type VerifyAppCheckTokenResponse,
} from "firebase-admin/app-check";
import { unauthorized } from "../errors";
import { firebaseApp } from "./firebase.service";

/// Verifies Firebase App Check tokens: proof that a request came from a genuine,
/// unmodified build of the Gurukul app.
///
/// This is app identity, entirely separate from user identity. It says nothing
/// about who is watching, so it does not — and must not — affect whether an
/// anonymous session may play a video.
///
/// Why a client-declared value could never do this: the attestation is signed
/// on-device by Play Integrity (bound to the package name *and* the release
/// signing certificate) or by Apple App Attest (bound to a hardware key and the
/// bundle id). Nothing shipped in the binary can produce one, so it cannot be
/// lifted out of an APK the way a package name, secret header or obfuscated key
/// can.

export type AppCheckVerifier = (
  token: string,
) => Promise<VerifyAppCheckTokenResponse>;

let verifier: AppCheckVerifier | undefined;

/// Test seam: verify without contacting Google.
export function setAppCheckVerifier(next: AppCheckVerifier | undefined): void {
  verifier = next;
}

export interface AttestedApp {
  /// The Firebase app id the attestation was issued to, e.g.
  /// `1:87028633648:android:…`. Identifies the app, not the user.
  appId: string;
}

export async function verifyAppCheckToken(token: string): Promise<AttestedApp> {
  try {
    const decoded = verifier
      ? await verifier(token)
      : await getAppCheck(firebaseApp()).verifyToken(token);
    return { appId: decoded.appId };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "invalid_app_check_token";
    throw unauthorized(code);
  }
}
