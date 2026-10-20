"use client";

// Ported from old_repo/src/lib/hooks/useWorkspaceBootstrap.ts (lines 26-233)
// Ported from old_repo/src/lib/hooks/useWorkspaceOverridesHydration.ts (lines 41-74)
// Ported from old_repo/src/lib/hooks/usePersonalState.ts (lines 34-62)
import { useEffect } from "react";

import { hydrateItemState, loadBootstrap, refreshBootstrap, resetBootstrap, useBootstrapStore } from "./bootstrap-store";

export { refreshBootstrap, useBootstrapStore } from "./bootstrap-store";
export type { AdminAttentionCounts, BootstrapMember, BootstrapPersonalItem, WorkspaceBootstrapData } from "./bootstrap-store";

/** The one per-session bootstrap (a null `userId` is signed out: the store is reset and nothing is fetched). Mounted once, in the shell. */
export function useBootstrap(userId: string | null) {
  const state = useBootstrapStore();
  useEffect(() => {
    const current = useBootstrapStore.getState();
    if (userId === null) {
      if (current.userId !== null || current.status !== "idle") resetBootstrap(null);
      return;
    }
    if (current.userId !== userId) resetBootstrap(userId);
    if (useBootstrapStore.getState().status === "idle") void loadBootstrap(userId);
  }, [userId]);
  useEffect(() => {
    const { data, hydratedFrom } = useBootstrapStore.getState();
    if (data && data !== hydratedFrom) {
      hydrateItemState(data);
      useBootstrapStore.setState({ hydratedFrom: data });
    }
  }, [state.data]);
  return { ...state, refresh: refreshBootstrap };
}
