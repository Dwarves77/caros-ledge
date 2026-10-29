// Ported from old_repo/src/lib/api/auth.ts (lines 38-67)
// Ported from old_repo/src/lib/api/community-auth.ts (lines 10-41)
import { LookupError } from "@/core/http/errors";

import { nameFromMetadata } from "./profile-name";

/** The auth surface a caller needs: anything shaped like a Supabase client. */
export interface ClaimsClient {
  auth: {
    getClaims: (jwt?: string) => Promise<{ data: { claims: { sub?: string; email?: string; user_metadata?: unknown } } | null; error: unknown }>;
    getSession?: () => Promise<{ data: { session: { access_token?: string; user?: { id?: string; email?: string; user_metadata?: unknown } } | null } | null; error: unknown }>;
  };
}

/** The auth service could not answer (network, saturation). A 503, never the same as "not signed in". */
export class ClaimsUnavailable extends LookupError {
  constructor(cause: unknown) { super("claims verification", cause); this.name = "ClaimsUnavailable"; }
}

/** The auth errors that mean this caller has no valid session (absent, malformed, expired). Every other error is the auth service failing to answer. */
const SIGNED_OUT = new Set(["AuthSessionMissingError", "AuthInvalidJwtError", "AuthInvalidTokenResponseError", "AuthInvalidCredentialsError", "AuthApiError"]);
/** An error that is not "no valid session": a 5xx or 429 from the auth service (whatever class it arrives as), a network error, or a class this code does not know: an outage, never a sign-out (C:25). */
function outage(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const { name, status } = error as { name?: unknown; status?: unknown };
  return (typeof status === "number" && (status >= 500 || status === 429)) || typeof name !== "string" || !SIGNED_OUT.has(name);
}

type VerifiedClaims = { userId: string; email: string | null; name: string | null } | null;
const claimsMemo = new WeakMap<ClaimsClient, Map<string, Promise<VerifiedClaims>>>();
const tokenCache = new Map<string, { claims: VerifiedClaims; expiresAt: number }>();

async function verifyClaims(client: ClaimsClient, jwt?: string, sessionOnly?: boolean): Promise<VerifiedClaims> {
  let token = jwt;
  if (!token && typeof client.auth.getSession === "function") {
    const s = await client.auth.getSession().catch((e) => { throw new ClaimsUnavailable(e); });
    if (s.error && outage(s.error)) throw new ClaimsUnavailable(s.error);
    if (!(token = s.data?.session?.access_token)) return null;
    const hit = tokenCache.get(token);
    if (hit && performance.now() < hit.expiresAt) return hit.claims;
    if (sessionOnly) return { userId: "session", email: null, name: null };
    if (s.data?.session?.user?.id) return (tokenCache.set(token, { claims: { userId: s.data.session.user.id, email: s.data.session.user.email ?? null, name: nameFromMetadata(s.data.session.user.user_metadata) }, expiresAt: performance.now() + 60_000 }), tokenCache.get(token)!.claims);
  }
  const result = await client.auth.getClaims(token).catch((e) => { throw new ClaimsUnavailable(e); });
  if (result.error && outage(result.error)) throw new ClaimsUnavailable(result.error);
  const sub = result.data?.claims?.sub;
  if (result.error || !sub) return null;
  const verified: VerifiedClaims = { userId: sub, email: result.data?.claims?.email ?? null, name: nameFromMetadata(result.data?.claims?.user_metadata) };
  if (token && typeof client.auth.getSession === "function") {
    if (tokenCache.size >= 256) tokenCache.delete(tokenCache.keys().next().value as string);
    tokenCache.set(token, { claims: verified, expiresAt: performance.now() + 60_000 });
  }
  return verified;
}

/** Verify a JWT locally (getClaims, never getUser per request), memoized per client and short-lived token cache. */
export function getClaims(client: ClaimsClient, jwt?: string, sessionOnly?: boolean): Promise<VerifiedClaims> {
  const key = `${jwt ?? ""}:${sessionOnly ? 1 : 0}`;
  let byJwt = claimsMemo.get(client);
  if (!byJwt) claimsMemo.set(client, (byJwt = new Map()));
  const hit = byJwt.get(key);
  if (hit) return hit;
  const p = verifyClaims(client, jwt, sessionOnly).catch((e) => { byJwt.delete(key); throw e; });
  return (byJwt.set(key, p), p);
}
