// Ported from old_repo/src/lib/api/auth.ts (lines 38-67)
// Ported from old_repo/src/lib/api/community-auth.ts (lines 10-41)
import { LookupError } from "@/core/http/errors";

/** The auth surface a caller needs: anything shaped like a Supabase client. */
export interface ClaimsClient {
  auth: {
    getClaims: (jwt?: string) => Promise<{ data: { claims: { sub?: string; email?: string } } | null; error: unknown }>;
  };
}

/** The auth service could not answer (network, saturation). A 503, never the same as "not signed in". */
export class ClaimsUnavailable extends LookupError {
  constructor(cause: unknown) {
    super("claims verification", cause);
    this.name = "ClaimsUnavailable";
  }
}

const transient = (error: unknown): boolean => !!error && typeof error === "object" && (error as { name?: unknown }).name === "AuthRetryableFetchError";

/**
 * Verify a JWT locally (getClaims, never getUser per request): the explicit `jwt`, or the client's own session.
 * Null means no valid session (absent, malformed or expired). A failure of the auth service itself throws ClaimsUnavailable.
 */
export async function getClaims(client: ClaimsClient, jwt?: string): Promise<{ userId: string; email: string | null } | null> {
  let result: Awaited<ReturnType<ClaimsClient["auth"]["getClaims"]>>;
  try {
    result = await client.auth.getClaims(jwt);
  } catch (e) {
    throw new ClaimsUnavailable(e);
  }
  if (result.error && transient(result.error)) throw new ClaimsUnavailable(result.error);
  const sub = result.data?.claims?.sub;
  if (result.error || !sub) return null;
  return { userId: sub, email: result.data?.claims?.email ?? null };
}
