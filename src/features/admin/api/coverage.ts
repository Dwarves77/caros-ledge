// Ported from old_repo/src/app/api/admin/coverage/route.ts (lines 62-299)
import { notCollected, readSourceCoverage } from "@/core/derived/source-coverage";
import { LookupError } from "@/core/http/errors";
import { log } from "@/core/shared/log";
import { countryGroupForIso, countryLabel, jurisdictionTier, subnational, TIER1, TIER2 } from "@/core/jurisdictions";

import { adminRoute, reply } from "./shared";

/** The window inside which an item counts as fresh for a cell: 180 days. */
const FRESHNESS_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
const NO_ITEMS = "__no_items__";
export type CellState = "covered-fresh" | "covered-stale" | "sparse" | "gap-with-source" | "gap-no-source";
export type OverallState = "covered" | "partial" | "gap";

interface RpcRow {
  jurisdiction_iso: string;
  item_type: string;
  item_count: number;
  source_count: number;
  most_recent_item_at: string | null;
  oldest_item_at: string | null;
  has_critical: boolean;
}
/** The tier a jurisdiction has in the one jurisdiction list: 1 must cover, 2 should cover, 3 any other code that parses, null a code that does not. */
const tierOf = (iso: string): 1 | 2 | 3 | null => jurisdictionTier(iso);
/** The country segment of a code, so a sub-national row groups under its country and a supranational code under itself. */
const countryGroup = (iso: string): string => countryGroupForIso(iso);

/** A cell's state: no items is a gap (with or without a tracked source); one or two is sparse; three or more is covered, fresh when the newest item is inside the window. Pure: `nowMs` is the request instant. */
function deriveCellState(itemCount: number, sourceCount: number, mostRecentAt: string | null, nowMs: number): CellState {
  if (itemCount === 0) return sourceCount === 0 ? "gap-no-source" : "gap-with-source";
  if (itemCount < 3) return "sparse";
  if (!mostRecentAt) return "covered-stale";
  return nowMs - Date.parse(mostRecentAt) <= FRESHNESS_WINDOW_MS ? "covered-fresh" : "covered-stale";
}
const deriveOverallState = (items: number, sources: number): OverallState => (items === 0 && sources === 0 ? "gap" : items < 3 ? "partial" : "covered");

/**
 * The jurisdiction by item-type matrix from the rpc rows: per-cell states, per-jurisdiction rollups, and every Tier 1 or Tier 2 jurisdiction the rpc returned nothing for as a gap row (the loudest gaps must show).
 * Filters narrow both. Pure.
 */
function buildAdminMatrix(rows: readonly RpcRow[], nowMs: number, filter: { tier?: 1 | 2 | 3 | null; country?: string | null } = {}) {
  const totals = new Map<string, { items: number; sources: number }>();
  const itemTypes = new Set<string>();
  const cells = rows.map((r) => {
    const items = Number(r.item_count) || 0;
    const sources = Number(r.source_count) || 0;
    if (r.item_type !== NO_ITEMS) itemTypes.add(r.item_type);
    const t = totals.get(r.jurisdiction_iso) ?? { items: 0, sources: 0 };
    totals.set(r.jurisdiction_iso, { items: t.items + items, sources: Math.max(t.sources, sources) });
    return { jurisdiction_iso: r.jurisdiction_iso, label: countryLabel(r.jurisdiction_iso) || r.jurisdiction_iso, country: countryGroup(r.jurisdiction_iso), item_type: r.item_type, item_count: items, source_count: sources, most_recent_item_at: r.most_recent_item_at, oldest_item_at: r.oldest_item_at, has_critical: !!r.has_critical, cell_state: deriveCellState(items, sources, r.most_recent_item_at, nowMs) };
  });
  for (const iso of new Set([...TIER1, ...TIER2])) {
    if (totals.has(iso)) continue;
    totals.set(iso, { items: 0, sources: 0 });
    cells.push({ jurisdiction_iso: iso, label: countryLabel(iso) || iso, country: countryGroup(iso), item_type: NO_ITEMS, item_count: 0, source_count: 0, most_recent_item_at: null, oldest_item_at: null, has_critical: false, cell_state: "gap-no-source" });
  }
  const jurisdictions = [...totals]
    .map(([iso, t]) => ({ jurisdiction_iso: iso, label: countryLabel(iso) || iso, country: countryGroup(iso), tier: tierOf(iso), is_subnational: subnational(iso), total_items: t.items, total_sources: t.sources, overall_state: deriveOverallState(t.items, t.sources) }))
    .sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99) || a.country.localeCompare(b.country) || a.label.localeCompare(b.label));
  const wanted = new Set(
    jurisdictions
      .filter((j) => (!filter.tier || j.tier === filter.tier) && (!filter.country || j.country.toUpperCase() === filter.country || j.jurisdiction_iso.toUpperCase().startsWith(filter.country)))
      .map((j) => j.jurisdiction_iso),
  );
  return { matrix: cells.filter((c) => wanted.has(c.jurisdiction_iso)), jurisdictions: jurisdictions.filter((j) => wanted.has(j.jurisdiction_iso)), item_types: [...itemTypes].sort() };
}

/** The coverage matrix for the console, from the one coverage rpc. A failed read is an error status, never an empty matrix. */
export const GET = adminRoute("/api/admin/coverage", async (admin, request) => {
  const q = new URL(request.url).searchParams;
  const t = Number(q.get("tier"));
  const country = q.get("country")?.trim().toUpperCase() || null;
  const { data, error } = await admin.service().rpc("coverage_matrix");
  if (error) throw new LookupError("coverage_matrix", error);
  const nowMs = Date.now();
  // The sources beside the matrix come from the source_coverage view (R2d addendum A): how many are collected and how many are not yet. A failed read is `null`, which the card states.
  const sources = await readSourceCoverage(admin.service()).then(
    (c) => ({ total: c.total, collected: c.byState.collected, not_collected: notCollected(c), refused: c.byState.refused, access_requested: c.byState.access_requested, last_capture_at: c.lastCaptureAt }),
    (e: unknown) => (log.warn("[admin coverage] source_coverage read failed:", e instanceof Error ? e.message : String(e)), null),
  );
  return reply(admin, { generated_at: new Date(nowMs).toISOString(), sources, ...buildAdminMatrix(Array.isArray(data) ? (data as RpcRow[]) : [], nowMs, { tier: t === 1 || t === 2 || t === 3 ? t : null, country }) });
});
