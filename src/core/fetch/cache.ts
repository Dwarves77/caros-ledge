// Ported from old_repo/src/lib/sources/fetch-hold.mjs (lines 56-99)
import { canonicalUrl, hostOf } from "@/core/shared";

import ttl from "./data/ttl.json";

/** Host TTLs in milliseconds: binding legal text changes rarely, news often. */
const HOST_TTL_MS: Readonly<Record<string, number>> = ttl.hostTtlMs;
export const DEFAULT_TTL_MS: number = ttl.defaultTtlMs;

export interface CacheEntry<T = unknown> {
  url: string;
  payload: T;
  fetchedAtMs: number;
}
export type FetchCache<T = unknown> = Map<string, CacheEntry<T>>;

/** The canonical cache key: two URLs differing only by case, www or trailing punctuation share one entry. */
export const fetchCacheKey = (url: string): string => canonicalUrl(url) ?? "";
export const ttlForUrl = (url: string, table: Readonly<Record<string, number>> = HOST_TTL_MS): number => table[hostOf(url)] ?? DEFAULT_TTL_MS;
export const isFresh = (entry: { fetchedAtMs: number } | null | undefined, nowMs: number, ttlMs: number): boolean => !!entry && nowMs - entry.fetchedAtMs < ttlMs;

export function cacheGet<T>(store: FetchCache<T> | null | undefined, url: string, nowMs: number): CacheEntry<T> | null {
  const entry = store?.get(fetchCacheKey(url));
  return entry && isFresh(entry, nowMs, ttlForUrl(url)) ? entry : null;
}
export function cachePut<T>(store: FetchCache<T> | null | undefined, url: string, payload: T, nowMs: number): CacheEntry<T> {
  const entry = { url, payload, fetchedAtMs: nowMs };
  store?.set(fetchCacheKey(url), entry);
  return entry;
}
