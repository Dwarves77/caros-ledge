// Ported from old_repo/src/lib/cache/fallback-guard.ts (lines 1-59)

const FALLBACK_NOT_CACHEABLE = "FallbackNotCacheable";

/** Carries the fallback payload through the cache callback's rejection path; `fallbackGuard` unwraps it and it never reaches a caller. */
class FallbackNotCacheableError extends Error {
  readonly payload: unknown;
  constructor(payload: unknown) {
    super(FALLBACK_NOT_CACHEABLE);
    this.name = FALLBACK_NOT_CACHEABLE;
    this.payload = payload;
  }
}
/** True when a resolved payload is a fail-soft fallback (`_error` set), not live data. */
export const isFallbackPayload = (value: unknown): boolean => typeof value === "object" && value !== null && Boolean((value as { _error?: string })._error);

/** Wrap the function handed to `unstable_cache`: a healthy payload passes and is cached; a fallback payload is thrown, so the entry is left untouched and the next request runs the real read again. */
function refuseToCacheFallback<A extends unknown[], R>(inner: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const result = await inner(...args);
    if (isFallbackPayload(result)) throw new FallbackNotCacheableError(result);
    return result;
  };
}
/** Wrap the call to the cached function: restore the fallback payload the guard threw; every other rejection (a real timeout, a real bug) propagates unchanged. */
async function readThroughFallbackGuard<R>(run: () => Promise<R>): Promise<R> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof FallbackNotCacheableError) return e.payload as R;
    throw e;
  }
}
/** The one name the surface read layer imports: refuse to cache a fallback, then read through the guard. */
export const fallbackGuard = { refuse: refuseToCacheFallback, readThrough: readThroughFallbackGuard };
