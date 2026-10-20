// Ported from old_repo/src/lib/api/authed-fetch.ts (lines 44-136)
import { browserClient } from "@/core/db/browser";

/** PROP-028/127: the one place a browser module attaches the caller's bearer to a request. */
export interface SessionSource {
  auth: { getSession: () => Promise<{ data: { session: { access_token?: string | null } | null } }> };
}
export interface AuthedFetchDeps {
  client?: SessionSource;
  fetchImpl?: typeof fetch;
}

const AUTH_REQUIRED_ERROR = "Authentication required";

async function accessToken(client: SessionSource): Promise<string | null> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** Headers carrying the bearer, or null when there is no session. */
export async function authHeaders(extra: Record<string, string> = {}, deps: AuthedFetchDeps = {}): Promise<Record<string, string> | null> {
  const token = await accessToken(deps.client ?? browserClient());
  return token ? { ...extra, Authorization: `Bearer ${token}` } : null;
}

/** fetch with the caller's bearer; no session answers a 401 response without a network call. */
export async function authedFetch(input: string, init?: RequestInit, deps: AuthedFetchDeps = {}): Promise<Response> {
  const token = await accessToken(deps.client ?? browserClient());
  if (!token) return new Response(JSON.stringify({ error: AUTH_REQUIRED_ERROR }), { status: 401, headers: { "content-type": "application/json" } });
  const headers = new Headers(init?.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);
  return (deps.fetchImpl ?? fetch)(input, { ...init, headers });
}
