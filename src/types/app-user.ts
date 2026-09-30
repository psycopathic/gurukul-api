/// The authenticated Gurukul user, derived from a verified Firebase ID token.
/// This is the only identity the API trusts — nothing here comes from the
/// request body or from a client-supplied header other than the token itself.
export interface AppUser {
  uid: string;

  /// True for Gurukul's default anonymous session. Anonymous users are real,
  /// authenticated users, but they are not treated as account holders.
  isAnonymous: boolean;

  /// `google.com`, `apple.com`, or `anonymous`.
  provider: string;

  /// Entitlement slugs from the token's custom claims (`entitlements`). Set
  /// server-side by whatever grants access; never self-declared by the client.
  entitlements: readonly string[];
}
