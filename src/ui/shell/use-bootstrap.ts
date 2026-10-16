"use client";

// Ported from old_repo/src/lib/hooks/useWorkspaceBootstrap.ts (lines 26-233)
// Ported from old_repo/src/lib/hooks/useWorkspaceOverridesHydration.ts (lines 41-74)
// Ported from old_repo/src/lib/hooks/usePersonalState.ts (lines 34-62)
import { useEffect } from "react";
import { create } from "zustand";

import { authHeaders } from "@/core/http/authed-fetch";
import { useItemStateStore, type WorkspaceOverride } from "@/features/workspace/state";

import type { NavCounts } from "./nav-counts.server";

export interface BootstrapMember {
  user_id: string;
  role: string;
  display_name: string;
  avatar_url: string | null;
}
export interface BootstrapPersonalItem {
  itemId: string;
  legacyId: string | null;
  title: string | null;
  isArchived: boolean;
  archiveNote: string | null;
  archivedAt: string | null;
}
export interface AdminAttentionCounts {
  total: number;
  [key: string]: number;
}
/** The /api/workspace/bootstrap bundle. A field whose read failed is null and named in `degraded`; null is "unknown", never "none". */
export interface WorkspaceBootstrapData {
  personalState: BootstrapPersonalItem[] | null;
  members: BootstrapMember[] | null;
  adminAttention: AdminAttentionCounts | null;
  overrides: WorkspaceOverride[] | null;
  navCounts: NavCounts | null;
  assistantEnabled: boolean;
  degraded: string[];
}

interface BootstrapState {
  userId: string | null;
  data: WorkspaceBootstrapData | null;
  status: "idle" | "loading" | "ready" | "failed";
  error: string | null;
  /** The data object the item-state stores were last hydrated from. */
  hydratedFrom: WorkspaceBootstrapData | null;
}
const IDLE: BootstrapState = { userId: null, data: null, status: "idle", error: null, hydratedFrom: null };
export const useBootstrapStore = create<BootstrapState>(() => IDLE);

let inFlight: Promise<void> | null = null;
let epoch = 0;

/** Forget everything (sign-out or a different user in the same tab): the next user never sees the first one's bundle. */
export function resetBootstrap(userId: string | null = null): void {
  epoch += 1;
  inFlight = null;
  useBootstrapStore.setState({ ...IDLE, userId });
}

async function load(userId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (inFlight) return inFlight;
  const mine = epoch;
  useBootstrapStore.setState({ status: "loading", error: null });
  inFlight = (async () => {
    let next: Partial<BootstrapState>;
    try {
      const headers = await authHeaders();
      if (!headers) next = { status: "idle" };
      else {
        const resp = await fetchImpl("/api/workspace/bootstrap", { headers });
        next = resp.ok ? { status: "ready", data: (await resp.json()) as WorkspaceBootstrapData } : { status: "failed", error: `HTTP ${resp.status}` };
      }
    } catch (e) {
      next = { status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    if (mine === epoch && useBootstrapStore.getState().userId === userId) useBootstrapStore.setState(next);
  })();
  try {
    await inFlight;
  } finally {
    if (mine === epoch) inFlight = null;
  }
}

export function refreshBootstrap(): void {
  const { userId } = useBootstrapStore.getState();
  if (userId) void load(userId);
}

/** Overrides and personal state into the item-state store, once per bundle. A degraded (null) field is left alone: it never overwrites state with an empty list. */
export function hydrateItemState(data: WorkspaceBootstrapData): void {
  const store = useItemStateStore.getState();
  if (data.overrides) store.setOverrides(data.overrides);
  if (data.personalState) store.setPersonalState(data.personalState.map((r) => ({ itemId: r.legacyId || r.itemId, isArchived: r.isArchived, archiveNote: r.archiveNote, archivedAt: r.archivedAt })));
}

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
    if (useBootstrapStore.getState().status === "idle") void load(userId);
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
