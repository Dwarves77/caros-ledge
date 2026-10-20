"use client";

// The bootstrap store: the bundle, its bounded retry, the epoch that discards a late answer, and the hydration of the item-state stores. The hook that mounts it is use-bootstrap.ts.
// Ported from old_repo/src/lib/hooks/useWorkspaceBootstrap.ts (lines 26-233)
// Ported from old_repo/src/lib/hooks/useWorkspaceOverridesHydration.ts (lines 41-74)
// Ported from old_repo/src/lib/hooks/usePersonalState.ts (lines 34-62)
import { create } from "zustand";

import { authHeaders } from "@/core/http/authed-fetch";
import { failureOf, RetryableError, retryDelayMs } from "@/core/http/backoff";
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

/** One bundle read for `userId`; a result that arrives after a reset or a user change is discarded. The fetch, the header source and the sleep are injectable for the tests. */
export async function loadBootstrap(
  userId: string,
  fetchImpl: typeof fetch = fetch,
  headersImpl: () => Promise<Record<string, string> | null> = authHeaders,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  if (inFlight) return inFlight;
  const mine = epoch;
  const current = () => mine === epoch && useBootstrapStore.getState().userId === userId;
  useBootstrapStore.setState({ status: "loading", error: null });
  inFlight = (async () => {
    let next: Partial<BootstrapState> = { status: "failed", error: "unknown" };
    // At most 1 + RETRY_LIMIT requests per round: 5xx and network errors back off 1 s, 2 s, 4 s; a 429 waits its Retry-After; any other 4xx is final.
    for (let made = 1; ; made += 1) {
      let failure: RetryableError;
      try {
        const headers = await headersImpl();
        if (!headers) {
          next = { status: "idle" };
          break;
        }
        const resp = await fetchImpl("/api/workspace/bootstrap", { headers });
        if (resp.ok) {
          next = { status: "ready", data: (await resp.json()) as WorkspaceBootstrapData };
          break;
        }
        failure = failureOf(resp.status, resp.headers.get("Retry-After"));
      } catch (e) {
        failure = e instanceof RetryableError ? e : new RetryableError(e instanceof Error ? e.message : String(e), null, true);
      }
      const delay = failure.retryable ? retryDelayMs(made, failure.retryAfterMs) : null;
      if (delay === null || !current()) {
        next = { status: "failed", error: failure.message };
        break;
      }
      await sleep(delay);
      if (!current()) return;
    }
    if (current()) useBootstrapStore.setState(next);
  })();
  try {
    await inFlight;
  } finally {
    if (mine === epoch) inFlight = null;
  }
}

export function refreshBootstrap(): void {
  const { userId } = useBootstrapStore.getState();
  if (userId) void loadBootstrap(userId);
}

/** Overrides and personal state into the item-state store, once per bundle. A degraded (null) field is left alone: it never overwrites state with an empty list. */
export function hydrateItemState(data: WorkspaceBootstrapData): void {
  const store = useItemStateStore.getState();
  if (data.overrides) store.setOverrides(data.overrides);
  if (data.personalState) store.setPersonalState(data.personalState.map((r) => ({ itemId: r.legacyId || r.itemId, isArchived: r.isArchived, archiveNote: r.archiveNote, archivedAt: r.archivedAt })));
}

