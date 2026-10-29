// Ported from old_repo/src/lib/supabase-env.ts (lines 1-3)
// Ported from old_repo/src/lib/supabase-server-client.ts (lines 1-27)
// Ported from old_repo/src/lib/supabase-service.ts (lines 25-37)
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cache } from "react";

import { log } from "@/core/shared/log";

import { cookieOptions } from "./cookie-options";

export type Db = SupabaseClient;

function publicEnv(): { url: string; anon: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("Supabase is not configured: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required.");
  return { url, anon };
}

export const isSupabaseConfigured = (): boolean => !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
export const isServiceConfigured = (): boolean => !!process.env.SUPABASE_SERVICE_ROLE_KEY;
export const missingServiceEnv = (env: Record<string, string | undefined>): string[] => ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((name) => !env[name]);

/** The bearer token of a request, or null. */
export function bearerToken(request?: Request): string | null {
  const header = request?.headers.get("authorization");
  return header && header.startsWith("Bearer ") ? header.slice(7) : null;
}

const cachedCookieClient = cache(async (): Promise<Db> => {
  const { url, anon } = publicEnv();
  const { cookies } = await import("next/headers");
  const store = await cookies();
  return createServerClient(url, anon, {
    cookieOptions: cookieOptions(),
    cookies: {
      getAll: () => store.getAll(),
      setAll(list) {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch (e) {
          log.warn("[auth] session cookie write skipped", e instanceof Error ? e.message : String(e));
        }
      },
    },
  }) as unknown as Db;
});

/** The caller's RLS-bound client: their bearer when the request carries one, else the request-scoped cookie session. */
export async function userClient(request?: Request): Promise<Db> {
  const token = bearerToken(request);
  if (token) {
    const { url, anon } = publicEnv();
    return createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  }
  return cachedCookieClient();
}

/** The proxy's request-bound client: cookie writes go to `onCookies` so the proxy can rebuild its response. */
export function requestClient(cookiesIn: { getAll: () => { name: string; value: string }[] }, onCookies: NonNullable<CookieMethodsServer["setAll"]>): Db {
  const { url, anon } = publicEnv();
  return createServerClient(url, anon, { cookieOptions: cookieOptions(), cookies: { getAll: () => cookiesIn.getAll(), setAll: onCookies } }) as unknown as Db;
}

let cachedService: Db | null = null;

/** Service-role client. Fail-closed (PROP-011/109): it never falls back to the anon key, and a service key equal to the anon key is refused. */
export function serviceClient(): Db {
  if (cachedService) return cachedService;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured. Service-role reads are unavailable (fail-closed, never downgraded to the anon key).");
  if (key === process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY equals the anon key; refusing to build a service client from it.");
  cachedService = createClient(url, key, { auth: { persistSession: false } });
  return cachedService;
}

/** A PostgREST error's full diagnostic surface, so a degraded read never hides its cause. */
export const describeError = (error: { message?: string; details?: string | null; hint?: string | null; code?: string | null }): string =>
  `message=${error.message ?? "unknown"} | details=${error.details ?? "none"} | hint=${error.hint ?? "none"} | code=${error.code ?? "none"}`;
