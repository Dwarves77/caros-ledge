// Ported from old_repo/src/lib/api/rate-limit.ts (lines 12-104)
import { isServiceConfigured, serviceClient, type Db } from "@/core/db/clients";
import { log } from "@/core/shared/log";

/** A fixed window per key (not a sliding window): 60 requests per 60 seconds, counted in Postgres across every instance when a service client exists (rate_limit_hit, migration 0019), else per instance in memory. */
export const WINDOW_MS = 60_000;
export const MAX_REQUESTS = 60;

/** A route's own budget (IMP-057): the default is 60 requests per 60 seconds; a worker route that does a batch of work per call asks for fewer. */
export interface RateBudget {
  limit?: number;
  windowMs?: number;
}

interface Entry {
  count: number;
  resetAt: number;
}
const store = new Map<string, Entry>();
/** What the last check of each key saw, so a success response can carry the headers whichever counter answered. */
const seen = new Map<string, { remaining: number; resetAt: number; limit: number }>();
let lastCleanup = 0;

/** The shared counter's client: the service client when the deployment has one, else null (the in-memory window answers). */
function sharedClient(): Db | null {
  if (!isServiceConfigured()) return null;
  try {
    return serviceClient();
  } catch {
    return null;
  }
}

/** One hit on the shared counter. Null when the database could not answer (the caller falls back to the in-memory window, which still limits). */
async function sharedHit(db: Db, key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; remaining: number; resetAt: number } | null> {
  try {
    const { data, error } = await db.rpc("rate_limit_hit", { p_key: key, p_limit: limit, p_window_seconds: Math.max(1, Math.round(windowMs / 1000)) });
    const row = (data as { allowed?: boolean; remaining?: number; reset_at?: string }[] | null)?.[0];
    if (error || !row || typeof row.allowed !== "boolean" || typeof row.remaining !== "number" || !row.reset_at) {
      log.warn("[rate-limit] the shared counter did not answer, using the per-instance window:", error?.message ?? "malformed reply");
      return null;
    }
    return { allowed: row.allowed, remaining: row.remaining, resetAt: new Date(row.reset_at).getTime() };
  } catch (e) {
    log.warn("[rate-limit] the shared counter failed, using the per-instance window:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Drop expired windows from both maps, at most every five minutes. */
function sweep(now: number): void {
  if (now - lastCleanup < 300_000) return;
  lastCleanup = now;
  for (const [k, e] of store) if (e.resetAt <= now) store.delete(k);
  for (const [k, e] of seen) if (e.resetAt <= now) seen.delete(k);
}

function localHit(key: string, now: number, limit: number, windowMs: number): { allowed: boolean; remaining: number; resetAt: number } {
  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowMs };
    store.set(key, fresh);
    return { allowed: true, remaining: limit - 1, resetAt: fresh.resetAt };
  }
  entry.count += 1;
  return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count), resetAt: entry.resetAt };
}

/** A mint run flushes many tags in a burst, so the worker-authenticated flush route gets its own budget (IMP-057), carried through rate_limit_hit as p_limit; user routes keep the default 60. */
export const WORKER_FLUSH_BUDGET: RateBudget = { limit: 600, windowMs: WINDOW_MS };
/**
 * Null when allowed, or the 429 response. `now` is injectable so the boundary can be tested; `db` is the shared counter's client (default: the
 * service client when configured; pass null to force the in-memory window). Every caller awaits it.
 */
export async function checkRateLimit(key: string, now = Date.now(), db?: Db | null, budget: RateBudget = {}): Promise<Response | null> {
  sweep(now);
  const limit = budget.limit ?? MAX_REQUESTS;
  const windowMs = budget.windowMs ?? WINDOW_MS;
  const client = db === undefined ? sharedClient() : db;
  const shared = client ? await sharedHit(client, key, limit, windowMs) : null;
  const hit = shared ?? localHit(key, now, limit, windowMs);
  seen.set(key, { remaining: hit.remaining, resetAt: hit.resetAt, limit });
  if (hit.allowed) return null;
  const retryAfter = Math.max(1, Math.ceil((hit.resetAt - now) / 1000));
  log.warn(`[rate-limit] ${key} exceeded ${limit} requests per ${windowMs / 1000}s (retry after ${retryAfter}s)`);
  return Response.json(
    { error: "Rate limit exceeded", limit, window: `${windowMs / 1000}s`, retry_after: retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter), "X-RateLimit-Limit": String(limit), "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.ceil(hit.resetAt / 1000)) } },
  );
}

/** Limiter key for callers with no user id: the first x-forwarded-for entry, else one shared bucket (fail closed). */
export function clientKey(request: { headers: Headers }): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first ? `ip:${first}` : "anon:unknown";
}

export function rateLimitHeaders(key: string): Record<string, string> {
  const entry = seen.get(key);
  if (!entry) return {};
  return { "X-RateLimit-Limit": String(entry.limit), "X-RateLimit-Remaining": String(entry.remaining), "X-RateLimit-Reset": String(Math.ceil(entry.resetAt / 1000)) };
}
