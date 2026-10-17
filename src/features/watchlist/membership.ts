"use client";

// Ported from old_repo/src/lib/watchlist/membership.ts (lines 59-64, 94-148)
// Ported from old_repo/src/components/ui/WatchButton.tsx (lines 77-163)
// Ported from old_repo/src/components/ui/WatchButton.tsx (lines 363-394)
// The watch membership every WatchToggle reads: ONE list fetch per item type per page, shared by every toggle on it, and a toggle writes through the route with an optimistic flip that reverts on a refused
// save. Only a SUCCESSFUL read is kept: a failed one leaves the control disabled (never "unwatched") and the next toggle that mounts reads again (the old cache pinned "unwatched" until reload).
import { useEffect, useState } from "react";
import { create } from "zustand";

import { authedFetch } from "@/core/http/authed-fetch";
import type { WatchScope } from "@/ui/WatchToggle";

import { isTeamOnlyWatchType, type WatchlistItemType } from "./links";

interface TypeState {
  status: "loading" | "ready" | "failed";
  watched: string[];
  team: string[];
  teamAvailable: boolean;
}
const useWatchStore = create<{ byType: Partial<Record<WatchlistItemType, TypeState>> }>(() => ({ byType: {} }));
const patch = (type: WatchlistItemType, next: Partial<TypeState>) => useWatchStore.setState((s) => ({ byType: { ...s.byType, [type]: { status: "loading", watched: [], team: [], teamAvailable: false, ...s.byType[type], ...next } } }));
const without = (list: string[], id: string) => list.filter((x) => x !== id);

/** Read one type's membership unless it is loaded or loading. */
export async function loadMembership(type: WatchlistItemType, call: typeof authedFetch = authedFetch): Promise<void> {
  if (["ready", "loading"].includes(useWatchStore.getState().byType[type]?.status ?? "")) return;
  patch(type, { status: "loading" });
  try {
    const res = await call(`/api/watchlist?item_type=${encodeURIComponent(type)}`);
    const body = res.ok ? ((await res.json()) as { watchedIds?: string[]; teamWatchedIds?: string[]; teamAvailable?: boolean }) : null;
    if (body) patch(type, { status: "ready", watched: body.watchedIds ?? [], team: body.teamWatchedIds ?? [], teamAvailable: !!body.teamAvailable });
    else patch(type, { status: "failed" });
  } catch {
    patch(type, { status: "failed" });
  }
}

/** Write one watch; the optimistic flip is reverted when the route refuses. True when the save landed. */
export async function setWatch(type: WatchlistItemType, id: string, scope: WatchScope, on: boolean, call: typeof authedFetch = authedFetch): Promise<boolean> {
  const flip = (to: boolean) => {
    const s = useWatchStore.getState().byType[type];
    const key = scope === "team" ? "team" : "watched";
    patch(type, { [key]: to ? [...(s?.[key] ?? []).filter((x) => x !== id), id] : without(s?.[key] ?? [], id) });
  };
  flip(on);
  let res: Response | null;
  try {
    res = on ? await call("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemType: type, itemId: id, scope }) }) : await call(`/api/watchlist?item_type=${encodeURIComponent(type)}&item_id=${encodeURIComponent(id)}&scope=${scope}`, { method: "DELETE" });
  } catch {
    res = null;
  }
  if (res?.ok) return true;
  flip(!on);
  return false;
}

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

/** Forget everything (sign-out or a new session), and read the store (the test seam). */
export const resetMembership = (): void => useWatchStore.setState({ byType: {} });
export const membershipOf = (type: WatchlistItemType): TypeState | undefined => useWatchStore.getState().byType[type];
