"use client";

// Ported from old_repo/src/lib/watchlist/membership.ts (lines 59-64, 94-148)
// Ported from old_repo/src/components/ui/WatchButton.tsx (lines 77-163)
// Ported from old_repo/src/components/ui/WatchButton.tsx (lines 363-394)
import { useEffect, useState } from "react";

import type { WatchScope } from "@/ui/WatchToggle";

import { isTeamOnlyWatchType, type WatchlistItemType } from "./links";
import { loadMembership, setWatch, useWatchStore } from "./watch-store";

/** The props of a WatchToggle for one item, kept in step with every other toggle of the same type. */
export function useWatchMembership(type: WatchlistItemType, id: string) {
  const state = useWatchStore((s) => s.byType[type]);
  const [failed, setFailed] = useState<WatchScope | null>(null);
  useEffect(() => void loadMembership(type), [type]);
  const teamOnly = isTeamOnlyWatchType(type);
  return {
    watched: !!state?.watched.includes(id),
    teamWatched: !!state?.team.includes(id),
    teamAvailable: !!state?.teamAvailable,
    teamOnly,
    loaded: state?.status === "ready",
    failed: failed === "personal",
    teamFailed: failed === "team",
    onToggle: async (scope: WatchScope) => {
      const on = !(scope === "team" ? state?.team : state?.watched)?.includes(id);
      setFailed((await setWatch(type, id, scope, on)) ? null : scope);
    },
  };
}

