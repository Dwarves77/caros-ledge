// Ported from old_repo/src/lib/data.ts (lines 72-79, 158-182)
// Ported from old_repo/src/lib/supabase-server.ts (lines 2637-2705)
// The one cached-read shape: a read runs under a deadline that always clears its timer, its result is cached by key and tag, and a FAILURE IS NEVER CACHED (a thrown read leaves the entry
// untouched; a payload carrying `_error` is refused by the fallback guard). The caller gets the value or the stated failure, never a zero that looks like data (INV-263).
import { unstable_cache } from "next/cache";

import { withTimeout, ReadTimeoutError } from "@/core/db/query";
import { log } from "@/core/shared/log";

import { fallbackGuard, isFallbackPayload } from "./fallback-guard";

/** The cache underneath, injectable: Next's unstable_cache in the app, a map in a test. */
export type CacheStore = <R>(fn: () => Promise<R>, key: string[], opts: { revalidate: number; tags: string[] }) => () => Promise<R>;
export type CachedRead<T> = { ok: true; value: T } | { ok: false; error: string; timedOut: boolean };

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Read `read()` through the cache. `key` must name everything the result depends on (the org, the window): the closure may hold a request-bound client, which is why the key, not the
 * arguments, identifies the entry. A failure or a timeout is logged once and returned as `{ ok: false }`.
 */
export async function cachedRead<T>(key: string[], read: () => Promise<T>, opts: { tags: string[]; revalidate: number; timeoutMs?: number; store?: CacheStore }): Promise<CachedRead<T>> {
  const guarded = fallbackGuard.refuse(() => withTimeout(read(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const store: CacheStore = opts.store ?? ((fn, k, o) => unstable_cache(fn, k, o) as never);
  try {
    const value = await fallbackGuard.readThrough(store(guarded, key, { revalidate: opts.revalidate, tags: opts.tags }));
    if (isFallbackPayload(value)) return { ok: false, error: String((value as { _error: string })._error), timedOut: false };
    return { ok: true, value };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.warn(`[cached-read] ${key.join(":")} failed: ${error}`);
    return { ok: false, error, timedOut: e instanceof ReadTimeoutError };
  }
}
