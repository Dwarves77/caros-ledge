// Ported from old_repo/src/lib/api/auth.ts (lines 38-67)
// Ported from old_repo/src/lib/api/community-auth.ts (lines 10-41)
import { LookupError } from "@/core/http/errors";

import { nameFromMetadata } from "./profile-name";

/** The auth surface a caller needs: anything shaped like a Supabase client. */
export interface ClaimsClient {
  auth: { getClaims: (jwt?: string) => Promise<{ data: { claims: { sub?: string; email?: string; user_metadata?: unknown } } | null; error: unknown }> };
}

/** The auth service could not answer (network, saturation). A 503, never the same as "not signed in". */
export class ClaimsUnavailable extends LookupError {
  constructor(cause: unknown) {
    super("claims verification", cause);
    this.name = "ClaimsUnavailable";
  }
}

/** The auth errors that mean this caller has no valid session (absent, malformed, expired). Every other error is the auth service failing to answer. */
const SIGNED_OUT = new Set(["AuthSessionMissingError", "AuthInvalidJwtError", "AuthInvalidTokenResponseError", "AuthInvalidCredentialsError", "AuthApiError"]);
/** An error that is not "no valid session": a 5xx or 429 from the auth service (whatever class it arrives as), a network error, or a class this code does not know: an outage, never a sign-out (C:25). */
function outage(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const { name, status } = error as { name?: unknown; status?: unknown };
  if (typeof status === "number" && (status >= 500 || status === 429)) return true;
  return typeof name !== "string" || !SIGNED_OUT.has(name);
}

type VerifiedClaims = { userId: string; email: string | null; name: string | null } | null;
const claimsMemo = new WeakMap<ClaimsClient, Map<string, Promise<VerifiedClaims>>>();

async function verifyClaims(client: ClaimsClient, jwt?: string): Promise<VerifiedClaims> {
  const result = await client.auth.getClaims(jwt).catch((e) => { throw new ClaimsUnavailable(e); });
  if (result.error && outage(result.error)) throw new ClaimsUnavailable(result.error);
  const sub = result.data?.claims?.sub;
  if (result.error || !sub) return null;
  return { userId: sub, email: result.data?.claims?.email ?? null, name: nameFromMetadata(result.data?.claims?.user_metadata) };
}

/** Verify a JWT locally (getClaims, never getUser per request), memoized per client instance within a request. */
export function getClaims(client: ClaimsClient, jwt?: string): Promise<VerifiedClaims> {
  const key = jwt ?? "";
  let byJwt = claimsMemo.get(client);
  if (!byJwt) claimsMemo.set(client, (byJwt = new Map()));
  const existing = byJwt.get(key);
  if (existing) return existing;
  const pending = verifyClaims(client, jwt).catch((e) => { byJwt.delete(key); throw e; });
  byJwt.set(key, pending);
  return pending;
}
