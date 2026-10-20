// Ported from old_repo/src/lib/watchlist-links.ts (lines 1-57)
// Ported from old_repo/src/lib/watchlist-scope.ts (lines 1-18)
// Ported from old_repo/src/app/api/watchlist/logic.ts (lines 1-25)
// The watch vocabulary: the six item types, the two scopes, the one type that only the team list holds, and each type's label. A row's link comes from the item itself (its type and domain through the one routing rule), so a watched type with no page renders unlinked. No imports, so the route and the client share it.
export const WATCH_TYPES = ["source", "reg", "signal", "research", "operations", "market_series"] as const;
export type WatchlistItemType = (typeof WATCH_TYPES)[number];
export type WatchlistScope = "personal" | "team";
export const isWatchType = (v: unknown): v is WatchlistItemType => (WATCH_TYPES as readonly unknown[]).includes(v);

/** A series is watched by the workspace, not by one person (WO-23): personal watching of it is refused. */
export const TEAM_ONLY_TYPES: ReadonlySet<string> = new Set(["market_series"]);
export const isTeamOnlyWatchType = (itemType: string): boolean => TEAM_ONLY_TYPES.has(itemType);
export const isTeamOnlyScopeViolation = (itemType: string, scope: string): boolean => isTeamOnlyWatchType(itemType) && scope !== "team";

/** The types that name a row of intelligence_items. */
export const ITEM_BACKED: ReadonlySet<string> = new Set(["reg", "signal", "research", "operations"]);

export const WATCHLIST_TYPE_LABEL: Record<WatchlistItemType, string> = { source: "Source", reg: "Regulation", signal: "Market signal", research: "Research", operations: "Operations", market_series: "Market series" };
