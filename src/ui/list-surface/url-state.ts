// Ported from old_repo/src/components/list-surface/list-surface-helpers.ts (lines 146-184)
// Ported from old_repo/src/components/list-surface/list-surface-helpers.ts (lines 413-464)
// Ported from old_repo/src/lib/url-params/regulations-region-link.ts (lines 1-32)
// The one URL vocabulary for list state (INV-264): a shared param name means one thing on every surface. The URL is replaced, not pushed.
import { BAND_ORDER, type UrgencyBandKey } from "@/core/lists";

import { EMPTY_FILTER_STATE, SORT_KEYS, WINDOW_OPTIONS, type ListSortKey, type ListWindowKey, type RowFilterState } from "./filter-sort";

export const PARAM = { band: "band", mode: "mode", region: "region", topic: "topic", tier: "tier", query: "q", sort: "sort", window: "window" } as const;

export interface ListUrlState {
  filter: RowFilterState;
  sort: ListSortKey | null;
  window: ListWindowKey | null;
  /** Surface extras (kind, dimension, theme ...): only the keys the surface declares. */
  extras: Record<string, string>;
}

export const bandFromParam = (v: string | null | undefined): UrgencyBandKey | null => BAND_ORDER.find((b) => b.key === v)?.key ?? null;
export const sortFromParam = (v: string | null | undefined): ListSortKey | null => SORT_KEYS.find((k) => k === v) ?? null;
export const windowFromParam = (v: string | null | undefined): ListWindowKey | null => WINDOW_OPTIONS.find((o) => o.key === v)?.key ?? null;

/** Read a list's whole state from the query string; an unknown band, sort or window reads as unset. */
export function parseListUrl(params: URLSearchParams | null | undefined, extraKeys: readonly string[] = []): ListUrlState {
  const get = (k: string): string | null => {
    const v = (params?.get(k) ?? "").trim();
    return v || null;
  };
  return {
    filter: { band: bandFromParam(params?.get(PARAM.band)), mode: get(PARAM.mode), region: get(PARAM.region), topic: get(PARAM.topic), tier: get(PARAM.tier), query: get(PARAM.query) ?? "" },
    sort: sortFromParam(params?.get(PARAM.sort)),
    window: windowFromParam(params?.get(PARAM.window)),
    extras: Object.fromEntries(extraKeys.flatMap((k) => (get(k) ? [[k, get(k) as string]] : []))),
  };
}

/** The query string for a state (no leading "?"); unset values are omitted, so the round trip is exact. */
export function serializeListUrl(state: Partial<ListUrlState> & { filter?: RowFilterState }): string {
  const p = new URLSearchParams();
  const put = (k: string, v: string | null | undefined) => {
    const t = (v ?? "").trim();
    if (t) p.set(k, t);
  };
  const f = state.filter ?? EMPTY_FILTER_STATE;
  put(PARAM.band, f.band);
  put(PARAM.mode, f.mode);
  put(PARAM.region, f.region);
  put(PARAM.topic, f.topic);
  put(PARAM.tier, f.tier);
  put(PARAM.query, f.query);
  put(PARAM.sort, state.sort);
  put(PARAM.window, state.window);
  for (const [k, v] of Object.entries(state.extras ?? {})) put(k, v);
  return p.toString();
}

/** Region codes: upper-cased, deduplicated, shape-checked. */
export function normalizeRegionCodes(raw: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  for (const c of raw ?? []) {
    const up = String(c ?? "").trim().toUpperCase();
    if (/^[A-Z0-9-]{2,10}$/.test(up)) seen.add(up);
  }
  return [...seen];
}

/** The map's link into a list: the list's OWN `region` facet, carrying the codes (a comma list matches any). */
export function regionLinkHref(listPath: string, codes: readonly string[] | null | undefined): string {
  const clean = normalizeRegionCodes(codes);
  return clean.length === 0 ? listPath : `${listPath}?${PARAM.region}=${encodeURIComponent(clean.join(","))}`;
}
