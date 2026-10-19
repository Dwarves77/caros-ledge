// Ported from old_repo/src/lib/forward-events/read-upcoming.mjs (lines 12-231)
// The upcoming-obligations read: forward events from a date, every kind but `other` by default, joined IN THE QUERY to admissible items (core/derived) and minus the events of a suppressed claim, narrowed by the
// workspace profile or the URL facets (jurisdiction and mode), with the hidden-by-scope count. Fixes: a failed events or item read throws (the old reader
// folded it into an empty result: B-1564/0058), and the scope filter is applied while paging until the limit is filled (the old overfetch of limit x 5 could
// starve a scoped read short). "uk" matches GB through the jurisdiction canon.
import { admitItems } from "@/core/derived/admissible";
import type { Db } from "@/core/db";
import { canonicalJurisdictionCode, GENERIC_JURISDICTIONS } from "@/core/entities/id";
import { qb } from "@/core/db";

import { DEFAULT_KINDS, EVENT_KINDS, type EventKind } from "../kinds";


import { rowsOf } from "./qb";
import { notInList, suppressedEventIds } from "@/core/derived/suppressed-events";

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const csvKeys = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean);

/** Region keys of a workspace profile's jurisdiction weights (generic scopes dropped), or null when none. */
export function defaultJurisdictionFilter(profileJurisdictions: unknown): string[] | null {
  if (!profileJurisdictions || typeof profileJurisdictions !== "object") return null;
  const keys = Object.keys(profileJurisdictions).map((k) => String(k).toLowerCase()).filter((k) => !GENERIC_JURISDICTIONS.has(k));
  return keys.length ? keys : null;
}

const canonLower = (code: unknown): string => (canonicalJurisdictionCode(code) ?? "").toLowerCase();
/** An item matches when any of its ISO codes equals a key or sits under it; no filter keeps everything, an item with no codes matches nothing. */
export function jurisdictionMatches(itemJurisdictionIso: readonly string[] | null | undefined, filterKeys: readonly string[] | null | undefined): boolean {
  if (!filterKeys || !filterKeys.length) return true;
  if (!Array.isArray(itemJurisdictionIso) || !itemJurisdictionIso.length) return false;
  const keys = filterKeys.map(canonLower).filter(Boolean);
  return itemJurisdictionIso.some((raw) => {
    const iso = canonLower(raw);
    return !!iso && keys.some((k) => iso === k || iso.startsWith(`${k}-`));
  });
}
/** An item matches the mode filter when it carries one of the modes, or declares none (mode-agnostic). */
export function modeMatches(itemModes: readonly string[] | null | undefined, modeKeys: readonly string[] | null | undefined): boolean {
  if (!modeKeys || !modeKeys.length || !Array.isArray(itemModes) || !itemModes.length) return true;
  const keys = modeKeys.map((k) => String(k ?? "").trim().toLowerCase()).filter(Boolean);
  return itemModes.some((m) => keys.includes(String(m ?? "").trim().toLowerCase()));
}

export interface Scope {
  modes: string[] | null;
  regions: string[] | null;
  source: { modes: "facet" | "profile" | null; regions: "facet" | "profile" | null };
}
/** The active scope: the URL facets win over the profile, per dimension. */
export function resolveScope(input: { facetModes?: unknown; facetRegions?: unknown; profileModes?: unknown; profileJurisdictions?: unknown } = {}): Scope {
  const facetModes = csvKeys(input.facetModes);
  const facetRegions = csvKeys(input.facetRegions).filter((k) => !GENERIC_JURISDICTIONS.has(k));
  const profileModes = csvKeys(input.profileModes);
  const profileRegions = defaultJurisdictionFilter(input.profileJurisdictions);
  return {
    modes: facetModes.length ? facetModes : profileModes.length ? profileModes : null,
    regions: facetRegions.length ? facetRegions : profileRegions,
    source: { modes: facetModes.length ? "facet" : profileModes.length ? "profile" : null, regions: facetRegions.length ? "facet" : profileRegions ? "profile" : null },
  };
}
export function scopeLabel(scope: Pick<Scope, "modes" | "regions"> | null | undefined): string {
  const title = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
  return [...(scope?.modes ?? []).map(title), ...(scope?.regions ?? []).map((k) => (k.length <= 4 ? k.toUpperCase() : title(k)))].join(", ");
}

export interface UpcomingSpec {
  itemId: string | null;
  kinds: EventKind[];
  from: string;
  limit: number;
}
export function buildUpcomingEventsQuerySpec(opts: { itemId?: string | null; kinds?: readonly unknown[]; from?: unknown; limit?: unknown }, todayIso: string): UpcomingSpec {
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? (opts.kinds.filter((k): k is EventKind => (EVENT_KINDS as readonly unknown[]).includes(k))) : [...DEFAULT_KINDS];
  return {
    itemId: opts.itemId ?? null,
    kinds,
    from: typeof opts.from === "string" && ISO_RE.test(opts.from) ? opts.from : todayIso,
    limit: typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0 ? Math.min(500, Math.floor(opts.limit)) : 8,
  };
}

export interface UpcomingItem {
  id: string;
  title: string | null;
  legacy_id: string | null;
  jurisdiction_iso: string[] | null;
  transport_modes: string[] | null;
}
export interface UpcomingEvent {
  id: string;
  intelligence_item_id: string;
  event_date: string;
  date_precision: string;
  event_kind: string;
  obligation_text: string;
  source_kind: string;
  confidence: string;
  item: UpcomingItem;
}
/** Events narrowed by scope, up to `limit`; an event whose item is not in the join never reaches here (the join is in the query). */
export function selectUpcoming(events: readonly UpcomingEvent[], opts: { jurisdictionFilter?: readonly string[] | null; modeFilter?: readonly string[] | null; limit?: number } = {}): UpcomingEvent[] {
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? Math.floor(opts.limit) : Infinity;
  const out: UpcomingEvent[] = [];
  for (const ev of events) {
    if (!ev?.item || !jurisdictionMatches(ev.item.jurisdiction_iso, opts.jurisdictionFilter) || !modeMatches(ev.item.transport_modes, opts.modeFilter)) continue;
    out.push(ev);
    if (out.length >= limit) break;
  }
  return out;
}

const PAGE = 100;
const MAX_PAGES = 20;
const SELECT = "id, intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_kind, confidence, item:intelligence_items!inner(id, title, legacy_id, jurisdiction_iso, transport_modes)";

export interface UpcomingResult {
  events: UpcomingEvent[];
  hiddenByScope: number | null;
  /** True when the scan stopped at its page cap: the hidden count is then a lower bound. */
  truncated: boolean;
}
/** Read upcoming events. Pages of the dated, verified-item-joined list are scanned until the scoped list fills (or, when the hidden count is wanted, the list ends or the cap is reached). */
export async function readUpcoming(sb: Db, opts: { itemId?: string | null; kinds?: readonly unknown[]; from?: unknown; limit?: unknown; jurisdictionFilter?: readonly string[] | null; modeFilter?: readonly string[] | null; countHidden?: boolean }, todayIso: string): Promise<UpcomingResult> {
  const spec = buildUpcomingEventsQuerySpec(opts, todayIso);
  const suppressed = notInList(await suppressedEventIds(sb));
  const wantAll = opts.countHidden === true;
  const unscoped: UpcomingEvent[] = [];
  let scoped: UpcomingEvent[] = [];
  let truncated = false;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    let q = admitItems(qb(sb.from("item_forward_events").select(SELECT)).gte("event_date", spec.from).in("event_kind", spec.kinds), "item");
    if (suppressed) q = q.not("id", "in", suppressed);
    if (spec.itemId) q = q.eq("intelligence_item_id", spec.itemId);
    const rows = rowsOf<UpcomingEvent>("item_forward_events", await q.order("event_date", { ascending: true }).order("created_at", { ascending: true }).order("id", { ascending: true }).range(page * PAGE, page * PAGE + PAGE - 1));
    unscoped.push(...rows);
    scoped = selectUpcoming(unscoped, { jurisdictionFilter: opts.jurisdictionFilter ?? null, modeFilter: opts.modeFilter ?? null });
    if (rows.length < PAGE) break;
    if (!wantAll && scoped.length >= spec.limit) break;
  }
  return { events: scoped.slice(0, spec.limit), hiddenByScope: wantAll ? unscoped.length - scoped.length : null, truncated };
}
