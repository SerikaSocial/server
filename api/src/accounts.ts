import { config } from "./config.ts";

// Client for serika-accounts, the identity provider. See docs/auth-integration.md for the
// verified behaviour of each endpoint.

export interface AccountsProfile {
  id: string;
  email: string;
  username: string;
  avatar?: string;
  isPremium: boolean;
  isAdmin: boolean;
}

export interface VerifyOAuthResult {
  valid: boolean;
  error?: string;
  code?: string;
  scopes?: string[];
  user?: AccountsProfile;
}

/// Exchange a PKCE authorization code for an opaque OAuth access token. These are public
/// clients, so there is no client_secret — only the code_verifier. The `client_id` and
/// `redirect_uri` MUST match the ones used in the authorize request, or the provider rejects
/// the exchange; callers pass the pair for their flow (game loopback vs web callback).
export async function exchangeCode(
  code: string,
  codeVerifier: string,
  clientId: string = config.accounts.clientId,
  redirectUri: string = config.accounts.redirectUri,
): Promise<{ access_token: string; refresh_token?: string } | null> {
  const res = await fetch(`${config.accounts.baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as any;
  if (!json.access_token) return null;
  return json;
}

/// Validate an opaque OAuth token AND check the ban flag. We use /internal/verify-oauth
/// rather than /oauth/userinfo specifically because userinfo does not check isBanned — a
/// banned user would otherwise sail straight through. (See docs/auth-integration.md.)
export async function verifyOAuth(accessToken: string): Promise<VerifyOAuthResult> {
  const res = await fetch(`${config.accounts.baseUrl}/internal/verify-oauth`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-key": config.accounts.internalKey,
    },
    body: JSON.stringify({ token: accessToken }),
  });
  if (!res.ok) return { valid: false, error: `accounts responded ${res.status}` };
  return (await res.json()) as VerifyOAuthResult;
}

/// Validate a serika-accounts **session JWT** (the token returned by /api/auth/login) and
/// check the ban flag. This is the JWT sibling of verifyOAuth: /internal/verify runs
/// jwt.verify() and looks the token up in the Session collection, whereas /internal/verify-oauth
/// only resolves opaque OAuth access tokens. The email/password login path issues a session
/// JWT — verifying it against verify-oauth is why in-game login returned `verify_failed`.
/// Both endpoints return the identical `{ valid, code, user }` shape.
export async function verifyAccountsSession(sessionJwt: string): Promise<VerifyOAuthResult> {
  const res = await fetch(`${config.accounts.baseUrl}/internal/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-key": config.accounts.internalKey,
    },
    body: JSON.stringify({ token: sessionJwt }),
  });
  if (!res.ok) return { valid: false, error: `accounts responded ${res.status}` };
  return (await res.json()) as VerifyOAuthResult;
}

/// Build the authorize URL the client opens in a browser to begin the PKCE flow.
export function authorizeUrl(state: string, codeChallenge: string): string {
  const u = new URL(`${config.accounts.baseUrl}/api/oauth/authorize`);
  u.searchParams.set("client_id", config.accounts.clientId);
  u.searchParams.set("redirect_uri", config.accounts.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "profile email");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export interface EmailLoginResult {
  /// The serika-accounts session JWT on success — verify it with verifyAccountsSession(),
  /// NOT verifyOAuth() (it is not an OAuth access token).
  token?: string;
  /// Set on failure. Mirrors serika-accounts' own codes where it sends them
  /// (EMAIL_NOT_VERIFIED, TWO_FACTOR_REQUIRED, TWO_FACTOR_INVALID, AGE_RESTRICTION),
  /// otherwise `invalid_credentials`.
  error?: string;
}

/// Login with email+password directly (no browser). Calls serika-accounts POST
/// /api/auth/login and returns its session JWT (or a distinguishable failure reason).
export async function loginWithEmail(
  email: string,
  password: string,
  twoFactorCode?: string,
): Promise<EmailLoginResult> {
  let json: any;
  try {
    const res = await fetch(`${config.accounts.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, twoFactorCode, productId: "serika-social" }),
    });
    json = await res.json().catch(() => ({}));
  } catch {
    return { error: "accounts_unreachable" };
  }

  // serika-accounts returns { token } on success and { error, code? } on failure.
  if (json?.token) return { token: json.token };
  // Prefer a machine-readable code; fall back to the human message, then a generic.
  return { error: json?.code ?? json?.error ?? "invalid_credentials" };
}
