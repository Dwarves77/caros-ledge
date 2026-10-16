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

import { GROUND_CONFIG, type TruncEvent } from "./config";

export interface PoolRow { id: string; url: string; text: string; index: number }
export interface TierSource { url: string; text: string; tier: number | null }

/** The one verbatim test (the database's criterion 3, case-insensitive): kept filter, re-homing and attribution all use it. */
export const spanIsVerbatim = isVerbatim;

/** Every pool row of the item, stubs included, ordered by result_index; a failed or over-long read fails loud (never an empty pool). */
export async function readAllPoolRows(sb: Db, itemId: string): Promise<PoolRow[]> {
  const r = await boundedRead<{ id: string; result_url: string | null; result_content: string | null; result_index: number | null }>(
    (limit) => sb.from("agent_run_searches").select("id, result_url, result_content, result_index").eq("intelligence_item_id", itemId).order("result_index", { ascending: true }).order("id", { ascending: true }).limit(limit),
    { limit: GROUND_CONFIG.MAX_ITEM_ROWS },
  );
  if (r.error) throw new LookupError("agent_run_searches", r.error);
  if (r.truncated) throw new LookupError("agent_run_searches", { message: `pool of ${itemId} reached the ${GROUND_CONFIG.MAX_ITEM_ROWS}-row bound` });
  return r.data.filter((x) => typeof x.result_url === "string").map((x) => ({ id: x.id, url: x.result_url as string, text: x.result_content ?? "", index: x.result_index ?? 0 }));
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
/** The voluntary-instrument family whose own-authoring-body FACT grounds at the issuing-body tier (migration 203's c_own_body_types). */
export const OWN_BODY_TYPES: readonly string[] = ["standard", "framework", "initiative"];
const OWN_BODY_TIER = 4;
/** The per-FACT floor: the item-type floor, or the issuing-body tier for an own-authoring-body FACT of the voluntary-instrument family. */
export function authorityFloorForFact(itemType: string | null | undefined, isOwnAuthoringBody: boolean): number | null {
  return OWN_BODY_TYPES.includes(String(itemType)) && isOwnAuthoringBody ? OWN_BODY_TIER : authorityFloorFor(itemType);
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

/**
 * The pool text the author reads: best tier first, unregistered last, stable within a tier. A floor-qualifying source is always
 * whole (the moat); a larger-than-ceiling one is surfaced as a wall; the rest share the remaining budget and every trim is reported.
 */
export function buildSourceBlocks(fetched: TierSource[], budget: number, opts: { floorTier: number | null; hardCeiling: number }): { blocks: string; trims: TruncEvent[]; ceilingWalls: TruncEvent[] } {
  const trims: TruncEvent[] = [];
  const ceilingWalls: TruncEvent[] = [];
  const ordered = fetched.map((s, i) => ({ ...s, i })).sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99) || a.i - b.i);
  const parts: string[] = [];
  let used = 0;
  for (const s of ordered) {
    if (opts.floorTier != null && s.tier != null && s.tier <= opts.floorTier) {
      if (s.text.length > opts.hardCeiling) ceilingWalls.push({ url: s.url, collected: 0, fullLength: s.text.length, cap: opts.hardCeiling, transport: "context-ceiling-wall(floor)" });
      else {
        parts.push(`### SOURCE url=${s.url}\n${s.text}`);
        used += s.text.length;
      }
      continue;
    }
    const room = Math.max(0, budget - used);
    if (room < 200) {
      trims.push({ url: s.url, collected: 0, fullLength: s.text.length, cap: 0, transport: "synthesis-budget(dropped)" });
      continue;
    }
    const t = s.text.length > room ? s.text.slice(0, room) : s.text;
    if (s.text.length > room) trims.push({ url: s.url, collected: room, fullLength: s.text.length, cap: room, transport: "synthesis-budget" });
    parts.push(`### SOURCE url=${s.url}\n${t}`);
    used += t.length;
  }
  return { blocks: parts.join("\n\n"), trims, ceilingWalls };
}

/** A brief section for the grounder: whole under the ceiling; over it, sliced WITH truncated=true so the caller surfaces it. */
export function prepareSectionForGrounding(contentMd: string | null | undefined, ceiling: number = GROUND_CONFIG.GROUND_SECTION_HARD_CEILING_CHARS): { text: string; truncated: boolean; fullLength: number; cap: number } {
  const full = String(contentMd ?? "");
  return full.length <= ceiling ? { text: full, truncated: false, fullLength: full.length, cap: ceiling } : { text: full.slice(0, ceiling), truncated: true, fullLength: full.length, cap: ceiling };
}
