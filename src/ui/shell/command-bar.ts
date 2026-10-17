// Ported from old_repo/src/components/ui/commandBarKeyboard.ts (lines 1-87)
// The command bar's pure decisions. Arrow moves clamp (never wrap); the Esc / outside-click / Enter table lives here so it is testable without a DOM.
import { clampIndex } from "../focus";

/** Arrow move in the results listbox: from nothing, Down lands on the first row and Up on the last; at either end it stays. */
export const moveActiveIndex = (current: number, direction: 1 | -1, count: number): number => (current < 0 ? (count === 0 ? -1 : direction === 1 ? 0 : count - 1) : clampIndex(count, current, direction));
export const isOutsidePointerDown = (withinBar: boolean, withinListbox: boolean): boolean => !withinBar && !withinListbox;
export const clearButtonVisible = (hasQueryText: boolean, dropdownOpen: boolean): boolean => hasQueryText || dropdownOpen;
export const clearButtonLabel = (hasQueryText: boolean): "Clear search" | "Close search" => (hasQueryText ? "Clear search" : "Close search");
export const optionId = (listboxId: string, index: number): string => `${listboxId}-option-${index}`;
export const activeDescendantId = (listboxId: string, activeIndex: number): string | undefined => (activeIndex >= 0 ? optionId(listboxId, activeIndex) : undefined);
/** The event the bar fires for Ask and the Assistant panel listens for. */
export const OPEN_ASK_EVENT = "open-ask-assistant";
export const searchResultsHref = (query: string): string => `/search?q=${encodeURIComponent(query)}`;

export type EnterAction = "ask" | "navigate-active" | "open-results";
/** Enter opens the results page; Enter on an active option opens it; Cmd/Ctrl+Enter asks. One bar, no toggle. */
export const resolveEnterKeyAction = (metaOrCtrl: boolean, activeIndex: number): EnterAction => (metaOrCtrl ? "ask" : activeIndex >= 0 ? "navigate-active" : "open-results");

export interface SearchResultRow {
  id: string;
  title: string;
  item_type: string | null;
  domain: number | null;
  priority: string | null;
  jurisdictions: string[] | null;
  transport_modes: string[] | null;
  topic: string | null;
}
export type SearchState = { phase: "idle" } | { phase: "loading" } | { phase: "ok"; rows: SearchResultRow[] } | { phase: "failed" };

/** A search response to a state: a non-ok answer or a thrown fetch is a FAILED search that says so, never "No results" (INV-263). */
export async function runSearch(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, query: string, signal?: AbortSignal): Promise<SearchState> {
  try {
    const res = await fetchImpl(`/api/search?q=${encodeURIComponent(query)}`, signal ? { signal } : {});
    if (!res.ok) return { phase: "failed" };
    const body = (await res.json()) as { results?: unknown };
    return Array.isArray(body.results) ? { phase: "ok", rows: body.results as SearchResultRow[] } : { phase: "failed" };
  } catch {
    return { phase: "failed" };
  }
}
