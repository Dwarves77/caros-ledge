// Ported from old_repo/src/lib/api/rate-limit.ts (lines 12-104)
import { log } from "@/core/shared/log";

/** A fixed window per key (not a sliding window), per server instance: 60 requests per 60 seconds. */
export const WINDOW_MS = 60_000;
export const MAX_REQUESTS = 60;

interface Entry {
  count: number;
  resetAt: number;
}
const store = new Map<string, Entry>();
let lastCleanup = 0;

/** Null when allowed, or the 429 response. `now` is injectable so the boundary can be tested. */
export function checkRateLimit(key: string, now = Date.now()): Response | null {
  if (now - lastCleanup >= 300_000) {
    lastCleanup = now;
    for (const [k, e] of store) if (e.resetAt <= now) store.delete(k);
  }
  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return null;
  }
  entry.count += 1;
  if (entry.count <= MAX_REQUESTS) return null;
  const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
  log.warn(`[rate-limit] ${key} exceeded ${MAX_REQUESTS} requests per minute (retry after ${retryAfter}s)`);
  return Response.json(
    { error: "Rate limit exceeded", limit: MAX_REQUESTS, window: "60s", retry_after: retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter), "X-RateLimit-Limit": String(MAX_REQUESTS), "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.ceil(entry.resetAt / 1000)) } },
  );
}

/** Limiter key for callers with no user id: the first x-forwarded-for entry, else one shared bucket (fail closed). */
export function clientKey(request: { headers: Headers }): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first ? `ip:${first}` : "anon:unknown";
}

export function rateLimitHeaders(key: string): Record<string, string> {
  const entry = store.get(key);
  if (!entry) return {};
  return { "X-RateLimit-Limit": String(MAX_REQUESTS), "X-RateLimit-Remaining": String(Math.max(0, MAX_REQUESTS - entry.count)), "X-RateLimit-Reset": String(Math.ceil(entry.resetAt / 1000)) };
}
