// Ported from old_repo/src/components/list-surface/list-surface-helpers.ts (lines 129-144, 186-312)
// Filter state, row filtering, sorting and the window filter. Nothing here reads a clock: `now` is passed in.
import { bandFromPriority, dueInfo, type UrgencyBandKey } from "@/core/lists";
import type { Resource } from "@/core/types";

export interface RowFilterState {
  band: UrgencyBandKey | null;
  mode: string | null;
  region: string | null;
  topic: string | null;
  tier: string | null;
  query: string;
}
export const EMPTY_FILTER_STATE: RowFilterState = { band: null, mode: null, region: null, topic: null, tier: null, query: "" };
export const isFilterActive = (f: RowFilterState): boolean => !!(f.band || f.mode || f.region || f.topic || f.tier || f.query.trim());

const haystack = (r: Resource): string => [r.title, r.jurisdiction, r.topic, ...(r.tags ?? []), r.whatIsIt, r.whyMatters].filter(Boolean).join(" \u0000 ").toLowerCase();

/** A region token is a jurisdiction name or an ISO code; a comma list matches any of its tokens (the map's region link). */
const regionMatches = (r: Resource, token: string): boolean => {
  const wanted = token.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const has = [(r.jurisdiction || "global").toLowerCase(), ...(r.jurisdictionIso ?? []).map((c) => c.toLowerCase())];
  return wanted.some((w) => has.includes(w));
};

export function filterRows(rows: Resource[], f: RowFilterState): Resource[] {
  let out = rows;
  if (f.band) out = out.filter((r) => bandFromPriority(r.priority).key === f.band);
  if (f.mode) out = out.filter((r) => (r.modes ?? []).includes(f.mode as string));
  if (f.region) out = out.filter((r) => regionMatches(r, f.region as string));
  if (f.topic) out = out.filter((r) => r.topic === f.topic);
  if (f.tier) out = out.filter((r) => String(r.sourceTier ?? "") === f.tier);
  const q = f.query.trim().toLowerCase();
  return q ? out.filter((r) => haystack(r).includes(q)) : out;
}

/** The detail-return contract: the list, the position, the total and the neighbours ride on the detail href. */
export function withListPosition(href: string, list: string, position: number, of: number, neighbors?: { prev?: string | null; next?: string | null }): string {
  let out = `${href}${href.includes("?") ? "&" : "?"}list=${encodeURIComponent(list)}&pos=${position}&of=${of}`;
  if (neighbors?.prev) out += `&prev=${encodeURIComponent(neighbors.prev)}`;
  if (neighbors?.next) out += `&next=${encodeURIComponent(neighbors.next)}`;
  return out;
}

export type ListSortKey = "next-date" | "newest" | "az" | "my-order";
export const SORT_KEYS: readonly ListSortKey[] = ["next-date", "newest", "az", "my-order"];

const time = (iso: string): number => new Date(iso).getTime();
/** "My order" is the identity sort (no fabricated drag order). `newest` puts an unparseable date last; `next-date` puts undated rows last. */
export function sortResourceRows(rows: Resource[], key: ListSortKey, now: Date): Resource[] {
  if (key === "my-order") return rows;
  const out = rows.slice();
  if (key === "az") return out.sort((a, b) => a.title.localeCompare(b.title));
  if (key === "newest") {
    return out.sort((a, b) => {
      const ta = time(a.added);
      const tb = time(b.added);
      return (Number.isNaN(tb) ? -Infinity : tb) - (Number.isNaN(ta) ? -Infinity : ta) || 0;
    });
  }
  return out.sort((a, b) => {
    const da = dueInfo(a, now)?.daysNum;
    const db = dueInfo(b, now)?.daysNum;
    if (da == null && db == null) return 0;
    return da == null ? 1 : db == null ? -1 : da - db;
  });
}

export type ListWindowKey = "7d" | "30d" | "90d" | "all";
export const WINDOW_OPTIONS: Array<{ key: ListWindowKey; label: string; days: number | null }> = [
  { key: "7d", label: "7d", days: 7 },
  { key: "30d", label: "30d", days: 30 },
  { key: "90d", label: "90d", days: 90 },
  { key: "all", label: "All", days: null },
];

/** Rows added within the window; an undated or unparseable row is KEPT (a window never drops what it cannot place). */
export function filterByWindow(rows: Resource[], key: ListWindowKey, now: Date): Resource[] {
  const days = WINDOW_OPTIONS.find((o) => o.key === key)?.days ?? null;
  if (days == null) return rows;
  const floor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - days * 86_400_000;
  return rows.filter((r) => {
    if (!r.added) return true;
    const ms = time(r.added + (r.added.length === 10 ? "T00:00:00Z" : ""));
    return Number.isNaN(ms) || ms >= floor;
  });
}
