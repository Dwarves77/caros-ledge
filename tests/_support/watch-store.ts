// The watch membership store as the tests read it: the state of one item type, and a reset between cases (sign-out).
import { useWatchStore } from "@/features/watchlist/watch-store";
import type { WatchlistItemType } from "@/features/watchlist/links";

export const membershipOf = (type: WatchlistItemType) => useWatchStore.getState().byType[type];
export const resetMembership = (): void => useWatchStore.setState({ byType: {} });
