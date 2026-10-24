import type { WatchlistItem } from "./read/watchlist";

/** Next date first (an undated row after the dated), the most recent watch first among equals: the order the card's aside states. Pure, so the client surface imports it without the server read (scripts/ci/checks/client-walk.mjs). */
export const byNextDate = (a: WatchlistItem, b: WatchlistItem): number => (a.dueDays ?? Infinity) - (b.dueDays ?? Infinity) || b.watchedAt.localeCompare(a.watchedAt);
