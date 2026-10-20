"use client";

// New in P2-10: the seam between the detail pages and the watchlist feature (P2-13 owns the membership read and the routes).
import { createContext, useContext } from "react";

import { WatchToggle, type WatchScope } from "../WatchToggle";

export interface WatchApi {
  /** The membership read has answered. */
  loaded: boolean;
  watched: boolean;
  teamWatched?: boolean;
  teamAvailable?: boolean;
  failed?: boolean;
  onToggle: (scope: WatchScope) => void;
}
/** The watchlist feature provides this per item; without a provider the control is the kit's not-yet-loaded state (disabled, never shown as unwatched). */
const WatchContext = createContext<((itemId: string) => WatchApi) | null>(null);

export function ItemWatch({ itemId, variant = "row" }: { itemId: string; variant?: "row" | "icon" | "default" }) {
  const api = useContext(WatchContext)?.(itemId) ?? null;
  return (
    <WatchToggle
      variant={variant}
      watched={api?.watched ?? false}
      loaded={api?.loaded ?? false}
      {...(api?.teamWatched !== undefined ? { teamWatched: api.teamWatched } : {})}
      {...(api?.teamAvailable !== undefined ? { teamAvailable: api.teamAvailable } : {})}
      {...(api?.failed ? { failed: true } : {})}
      onToggle={api?.onToggle ?? (() => undefined)}
    />
  );
}
