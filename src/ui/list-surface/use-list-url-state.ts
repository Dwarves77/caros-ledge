"use client";

// Ported from old_repo/src/components/list-surface/useListSurfaceFilter.ts (lines 23-86)
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import { EMPTY_FILTER_STATE, isFilterActive, type ListSortKey, type ListWindowKey, type RowFilterState } from "./filter-sort";
import { parseListUrl, serializeListUrl, type ListUrlState } from "./url-state";

/** The list's state in the URL (replace, not push): filter facets, sort, window and the surface's declared extras. */
export function useListUrlState(extraKeys: readonly string[] = []) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const key = extraKeys.join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the stable identity of extraKeys
  const state = useMemo(() => parseListUrl(params, extraKeys), [params, key]);
  const write = useCallback(
    (next: ListUrlState) => {
      const qs = serializeListUrl(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
  const setFacet = useCallback((facet: keyof RowFilterState, value: string | null) => write({ ...state, filter: { ...state.filter, [facet]: facet === "query" ? (value ?? "") : value } }), [state, write]);
  const toggleFacet = useCallback((facet: keyof RowFilterState, value: string | null) => write({ ...state, filter: { ...state.filter, [facet]: state.filter[facet] === value ? null : value } }), [state, write]);
  const setSort = useCallback((sort: ListSortKey | null) => write({ ...state, sort }), [state, write]);
  const setWindow = useCallback((window: ListWindowKey | null) => write({ ...state, window }), [state, write]);
  const setExtra = useCallback((k: string, v: string | null) => write({ ...state, extras: Object.fromEntries(Object.entries({ ...state.extras, [k]: v }).filter(([, x]) => x)) as Record<string, string> }), [state, write]);
  const clear = useCallback(() => write({ ...state, filter: { ...EMPTY_FILTER_STATE } }), [state, write]);
  return { ...state, setFacet, toggleFacet, setSort, setWindow, setExtra, clear, active: isFilterActive(state.filter) };
}
