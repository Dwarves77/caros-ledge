// Ported from old_repo/src/lib/agent/source-blocks.mjs (lines 19-93)
// Ported from old_repo/src/lib/agent/source-pool-hash.mjs (lines 17-33)
// Ported from old_repo/src/lib/agent/floor-attribution.mjs (lines 12-40)
// Ported from old_repo/src/lib/agent/section-grounding.mjs (lines 3-15)
// Ported from old_repo/src/lib/forward-events/read-and-extract.mjs (lines 105-113)
// The item's pool (its stored captures), its identity hash, the per-type authority floor, floor-first re-attribution and the
// tier-ordered pool text the author reads.
import { createHash } from "node:crypto";

import { isVerbatim } from "@/core/contracts/verbatim";
import { boundedRead, type Db } from "@/core/db";
import { LookupError } from "@/core/http/errors";

import { GROUND_CONFIG } from "./config";

export interface PoolRow { id: string; url: string; text: string; index: number; /** the BCP-47 number locale the capture declares, or null */ number_locale?: string | null }
export interface TierSource { url: string; text: string; tier: number | null }

/** Every pool row of the item, stubs included, ordered by result_index; a failed or over-long read fails loud (never an empty pool). */
export async function readAllPoolRows(sb: Db, itemId: string): Promise<PoolRow[]> {
  const r = await boundedRead<{ id: string; result_url: string | null; result_content: string | null; result_index: number | null; number_locale: string | null }>(
    (limit) => sb.from("agent_run_searches").select("id, result_url, result_content, result_index, number_locale").eq("intelligence_item_id", itemId).order("result_index", { ascending: true }).order("id", { ascending: true }).limit(limit),
    { limit: GROUND_CONFIG.MAX_ITEM_ROWS },
  );
  if (r.error) throw new LookupError("agent_run_searches", r.error);
  if (r.truncated) throw new LookupError("agent_run_searches", { message: `pool of ${itemId} reached the ${GROUND_CONFIG.MAX_ITEM_ROWS}-row bound` });
  return r.data.filter((x) => typeof x.result_url === "string").map((x) => ({ id: x.id, url: x.result_url as string, text: x.result_content ?? "", index: x.result_index ?? 0, number_locale: x.number_locale }));
}

/** Rows that carry real content (over the usable-capture floor), in result_index order: the pool the author reads and the hash covers. */
export const usableCaptures = (rows: PoolRow[]): PoolRow[] => rows.filter((r) => r.text.trim().length > GROUND_CONFIG.MIN_USABLE_POOL_CHARS).sort((a, b) => a.index - b.index);
export async function readPool(sb: Db, itemId: string): Promise<PoolRow[]> {
  return usableCaptures(await readAllPoolRows(sb, itemId));
}

const SEP = String.fromCharCode(0);
/** Order-independent sha256 of a pool's {url, text} pairs (NUL-joined, so adjacent fields cannot shift across the boundary). */
export function poolHash(rows: { url?: unknown; text?: unknown }[]): string {
  const norm = (rows ?? []).map((r) => ({ url: typeof r?.url === "string" ? r.url : "", text: typeof r?.text === "string" ? r.text : "" })).sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const h = createHash("sha256");
  for (const r of norm) h.update(r.url).update(SEP).update(r.text).update(SEP);
  return h.digest("hex");
}

/**
 * The authority floor: the max tier number a CRITICAL/HIGH item's FACT may ground to (null = floor-exempt). The JS mirror of the
 * `v_floor_max` CASE in validate_item_provenance (supabase/schema.sql 6004-6009; the own-body family is at 5965); a test parses the schema and fails on drift.
 */
export function authorityFloorFor(itemType: string | null | undefined): number | null {
  switch (itemType) {
    case "regulation": case "directive": case "standard": case "guidance": case "framework": return 2;
    case "research_finding": return 4;
    case "technology": case "innovation": case "tool": return 5;
    default: return null;
  }
}

/** Floor-qualifying sources, best tier first. */
export function floorPool<T extends { tier: number | null }>(pool: T[], floorTier: number | null): T[] {
  return floorTier == null ? [] : pool.filter((s) => s.tier != null && s.tier <= floorTier).sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99));
}

/**
 * Floor-first re-attribution: the floor source whose capture VERBATIM contains the span (best tier first), or null. Fires only when
 * the current attribution is below the floor or unresolved; never forced (null on a short span or a span absent from every floor source).
 */
export function reattributeToFloor<T extends { text: string }>(span: string | null | undefined, currentTier: number | null, ordered: T[], floorTier: number | null): T | null {
  if (floorTier == null || (currentTier != null && currentTier <= floorTier)) return null;
  if (String(span ?? "").trim().length < GROUND_CONFIG.MIN_SPAN_CHARS) return null;
  return ordered.find((s) => isVerbatim(s.text, span)) ?? null;
}

