// Ported from old_repo/scripts/mint/export-census-rows.mjs (lines 660-797)
// Ported from old_repo/scripts/mint/export-census-rows.mjs (lines 1416-1456)
// Ported from old_repo/scripts/mint/lib/instrument-identity.mjs (lines 1-19)
// Ported from old_repo/scripts/mint/apply-mint-batch.mjs (lines 70-120)
// Select the would_mint census rows and decide, with ONE held index and ONE predicate, which are already held: by canonical key first, then by URL with the same
// instrument identity (archived holders included). The same predicate runs again at insert (gates.ts), so an export-time exclusion can never disagree with the
// refusal it pre-empts.
import type { Db } from "@/core/db";
import { fetchAllByIdChunks, fetchAllRows } from "@/core/db";

import type { CensusRow, Holder } from "./types";

export const LIMIT_CEILING = 100;

/** The effective cap: a positive integer, never above the ceiling. Throws on anything else (a bad cap is a caller bug, not a silent clamp). */
export function resolveLimit(limit: number | null | undefined): number {
  const n = limit ?? 50;
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`mint limit must be a positive integer (got ${String(limit)})`);
  if (n > LIMIT_CEILING) throw new RangeError(`mint limit must not exceed the ceiling of ${LIMIT_CEILING} (got ${n})`);
  return n;
}

export const normalizeIdentifier = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);

/**
 * THE same-document rule. Two identifiers name the same document when both are unlabelled (fail closed) or both are labelled and equal once normalised. Two
 * labelled, different identifiers are siblings (a series sharing one landing page), not a duplicate. An unlabelled side is presumed the same document.
 */
export function sameInstrumentIdentity(a: unknown, b: unknown): boolean {
  const p = normalizeIdentifier(a);
  const h = normalizeIdentifier(b);
  return p != null && h != null ? p === h : true;
}

export interface HeldIndex {
  byKey: Map<string, Holder[]>;
  byUrl: Map<string, Holder[]>;
}
export function buildHeldIndex(items: Iterable<Holder>): HeldIndex {
  const byKey = new Map<string, Holder[]>();
  const byUrl = new Map<string, Holder[]>();
  for (const it of items) {
    if (it.canonical_instrument_key) byKey.set(it.canonical_instrument_key, [...(byKey.get(it.canonical_instrument_key) ?? []), it]);
    if (it.source_url) byUrl.set(it.source_url, [...(byUrl.get(it.source_url) ?? []), it]);
  }
  return { byKey, byUrl };
}

export interface HeldQuery {
  url: string | null | undefined;
  key: string | null | undefined;
  instrumentIdentifier: string | null | undefined;
}
export type HeldVerdict = { held: false } | { held: true; by: "key" | "url"; holderId: string; archived: boolean };

/** The one predicate: the canonical key first (unconditional), then the URL with the same instrument identity. */
export function isHeld(q: HeldQuery, index: HeldIndex): HeldVerdict {
  const keyHolder = q.key ? index.byKey.get(q.key)?.[0] : undefined;
  if (keyHolder) return { held: true, by: "key", holderId: keyHolder.id, archived: keyHolder.archive_reason != null };
  const urlHolder = q.url ? index.byUrl.get(q.url)?.find((h) => sameInstrumentIdentity(q.instrumentIdentifier, h.instrument_identifier)) : undefined;
  return urlHolder ? { held: true, by: "url", holderId: urlHolder.id, archived: urlHolder.archive_reason != null } : { held: false };
}

const HOLDER_COLUMNS = "id, source_url, canonical_instrument_key, instrument_identifier, archive_reason";
/** The holders of these URLs and keys, archived rows included. A failed chunk read throws: an unreadable corpus is never an empty one. */
export async function readHolders(sb: Db, urls: Iterable<string>, keys: Iterable<string>): Promise<Holder[]> {
  const read = (column: "source_url" | "canonical_instrument_key", values: Iterable<string>) =>
    fetchAllByIdChunks(values, async (slice) => {
      const r = await sb.from("intelligence_items").select(HOLDER_COLUMNS).in(column, slice);
      if (r.error) throw new Error(`holder read by ${column} failed: ${r.error.message}`);
      if ((r.data ?? []).length >= 1000) throw new Error(`holder read by ${column} may be truncated at the server row cap; narrow the slice`);
      return (r.data ?? []) as Holder[];
    }, { manyPerId: true });
  const [byUrl, byKey] = await Promise.all([read("source_url", urls), read("canonical_instrument_key", keys)]);
  return [...new Map([...byUrl, ...byKey].map((h) => [h.id, h])).values()];
}

const CENSUS_COLUMNS = "id, source_id, document_url, title, surface_tags, instrument_identifier, dryrun_disposition, hold_reason, notes, is_archived, enumeration_status";
/** would_mint, not archived, not already reconciled (a verified mint is never selected again), optionally narrowed by source or CELEX prefix. Every page is read (a total order by id); a failed page throws. */
export async function selectCensusRows(sb: Db, f: { sourceId?: string | null; celexPrefix?: string | null } = {}): Promise<CensusRow[]> {
  const rows = await fetchAllRows<CensusRow>((from, to) => {
    let q = sb.from("census_worklist").select(CENSUS_COLUMNS).eq("dryrun_disposition", "would_mint").eq("is_archived", false).neq("enumeration_status", "reconciled");
    if (f.sourceId) q = q.eq("source_id", f.sourceId);
    return q.order("id", { ascending: true }).range(from, to) as never;
  }, { cap: 200_000 });
  return rows.filter((r) => r.dryrun_disposition === "would_mint" && !r.is_archived && r.enumeration_status !== "reconciled" && (!f.sourceId || r.source_id === f.sourceId) && (!f.celexPrefix || String(r.instrument_identifier ?? "").startsWith(f.celexPrefix)));
}
