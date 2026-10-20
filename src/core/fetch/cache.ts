// Ported from old_repo/src/lib/sources/fetch-hold.mjs (lines 56-99)

export interface CacheEntry<T = unknown> {
  url: string;
  payload: T;
  fetchedAtMs: number;
}
export type FetchCache<T = unknown> = Map<string, CacheEntry<T>>;

