import { cert, getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { env } from "../config/env";
import type { AppUser } from "../types/app-user";
import { unauthorized } from "../errors";

/// Verifies Firebase ID tokens minted by the Gurukul Flutter app. This reuses
/// the app's existing Firebase Auth session — there is no second login system,
/// no API keys handed to clients, and no password handling here.

function serviceAccountCredential() {
  if (env.firebaseServiceAccountJson) {
    return cert(JSON.parse(env.firebaseServiceAccountJson));
  }
  if (env.firebaseServiceAccountPath) {
    return cert(env.firebaseServiceAccountPath);
  }
  // GOOGLE_APPLICATION_CREDENTIALS / workload identity on managed hosts.
  return applicationDefault();
}

/// The one Admin SDK app, shared by ID-token and App Check verification.
export function firebaseApp() {
  const existing = getApps()[0];
  if (existing) return existing;
  return initializeApp({
    credential: serviceAccountCredential(),
    projectId: env.firebaseProjectId,
  });
}

export type TokenVerifier = (idToken: string) => Promise<DecodedIdToken>;

let verifier: TokenVerifier | undefined;

/// Test seam: swap in a fake verifier so the auth and authorization paths can be
/// exercised without contacting Google.
export function setTokenVerifier(next: TokenVerifier | undefined): void {
  verifier = next;
}

function providerOf(token: DecodedIdToken): string {
  const signIn = token.firebase?.sign_in_provider;
  return typeof signIn === "string" && signIn.length > 0 ? signIn : "unknown";
}

function entitlementsOf(token: DecodedIdToken): readonly string[] {
  const claim = (token as Record<string, unknown>).entitlements;
  if (!Array.isArray(claim)) return [];
  return claim.filter((value): value is string => typeof value === "string");
}

export async function verifyAppUser(idToken: string): Promise<AppUser> {
  let token: DecodedIdToken;
  try {
    // `true` checks revocation, so a signed-out or disabled user stops working
    // immediately instead of at token expiry.
    token = verifier
      ? await verifier(idToken)
      : await getAuth(firebaseApp()).verifyIdToken(idToken, true);
  } catch (error) {
    const code = (error as { code?: string }).code ?? "invalid_token";
    throw unauthorized(code);
  }

  const provider = providerOf(token);
  return {
    uid: token.uid,
    isAnonymous: provider === "anonymous",
    provider,
    entitlements: entitlementsOf(token),
  };
}
