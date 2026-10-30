"use client";

// Ported from old_repo/src/stores/resourceStore.ts (lines 1-570)
import { create } from "zustand";

import { authedFetch, type AuthedFetchDeps } from "@/core/http/authed-fetch";
import type { Resource } from "@/core/types";
import { log } from "@/core/shared/log";
import { parseJsonOrNull } from "@/core/shared/text";
import { registerItemStateHydrator } from "@/ui/shell/bootstrap-store";

import type { PersonalItemState, WorkspaceOverride } from "./types";

export type { PersonalItemState, WorkspaceOverride } from "./types";

/** What the store sends its writes through (the session source and fetch); the default is the browser session and global fetch. `setTransport` on the store replaces it. */
let transport: AuthedFetchDeps = {};

const OVERRIDES_PATH = "/api/workspace/overrides";
const PERSONAL_PATH = "/api/workspace/personal-state";

/**
 * The one authed-JSON seam for every workspace and personal write. It resolves the server's own error MESSAGE, not a boolean: the dual-scope
 * archive has user-actionable failures ("Workspace archive requires the admin or owner role. You can archive it just for yourself instead.")
 * that the UI shows verbatim.
 */
async function persist(path: string, payload: Record<string, unknown>, method: "POST" | "DELETE"): Promise<string | null> {
  try {
    const response = await authedFetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, transport);
    if (response.ok) return null;
    if (response.status === 401) return "You are signed out. Sign in and try again.";
    const text = await response.text().catch(() => "");
    log.error(`[item-state] ${path} ${method} returned ${response.status}: ${text.slice(0, 300)}`);
    const parsed = parseJsonOrNull(text) as { error?: unknown } | null;
    if (typeof parsed?.error === "string" && parsed.error) return parsed.error;
    return `Request failed (${response.status}).`;
  } catch (e) {
    log.error(`[item-state] ${path} request failed:`, e instanceof Error ? e.message : e);
    return "Network error. Your change was not saved.";
  }
}

interface ItemStateStore {
  /** Platform data (shared, never mutated by workspace actions). */
  resources: Resource[];
  archived: Resource[];
  /** Workspace overrides (org-scoped, layered on top of platform data) and personal state (user-scoped, on top of the override). */
  overrides: Map<string, WorkspaceOverride>;
  personalState: Map<string, PersonalItemState>;
  expandedId: string | null;

  setResources: (resources: Resource[]) => void;
  setArchived: (archived: Resource[]) => void;
  setOverrides: (overrides: WorkspaceOverride[]) => void;
  setPersonalState: (rows: PersonalItemState[]) => void;
  setExpanded: (id: string | null) => void;
  setTransport: (deps: AuthedFetchDeps) => void;

  /**
   * Every action below applies its change locally, writes it, and rolls the entry back when the write fails; each resolves to the server's
   * error message (null on success). The workspace archive can legitimately refuse (403 role gate, 400 missing reason) and the dialog
   * must show the server's own wording.
   */
  /** A workspace-wide priority is an owner or admin act and carries the sentence that says why (set_priority_override). */
  updatePriority: (id: string, priority: Resource["priority"], reason: string) => Promise<string | null>;
  setOwner: (id: string, ownerUserId: string | null, ownerName: string | null) => Promise<string | null>;
  dismissResource: (id: string) => Promise<string | null>;
  restoreDismissed: (id: string) => Promise<string | null>;
  archiveResource: (id: string, reason: string, note: string) => Promise<string | null>;
  /** Restoring a team archive is an owner or admin act and carries its reason (restore_team_item). */
  restoreResource: (id: string, reason: string) => Promise<string | null>;
  archivePersonal: (id: string, note: string) => Promise<string | null>;
  restorePersonal: (id: string) => Promise<string | null>;
}

const blank = (itemId: string): WorkspaceOverride => ({ itemId, priorityOverride: null, isArchived: false, archiveReason: null, archiveNote: null, dismissedAt: null });
const toMap = <T extends { itemId: string }>(rows: T[]): Map<string, T> => new Map(rows.map((r) => [r.itemId, r]));

export const useItemStateStore = create<ItemStateStore>((set, get) => {
  /** Put (or, with null, remove) one entry of a layer. */
  function put<K extends "overrides" | "personalState">(layer: K, id: string, entry: ItemStateStore[K] extends Map<string, infer V> ? V | null : never) {
    set((state) => {
      const next = new Map(state[layer] as Map<string, unknown>);
      if (entry === null) next.delete(id);
      else next.set(id, entry);
      return { [layer]: next } as Pick<ItemStateStore, K>;
    });
  }

  /** The one optimistic write: apply `next` to the entry, persist, and put the previous entry back when the write fails. */
  async function optimistic<K extends "overrides" | "personalState">(
    layer: K,
    id: string,
    next: ItemStateStore[K] extends Map<string, infer V> ? V | null : never,
    request: { path: string; payload: Record<string, unknown>; method?: "POST" | "DELETE" },
  ): Promise<string | null> {
    const prev = (get()[layer] as Map<string, unknown>).get(id) ?? null;
    put(layer, id, next);
    const error = await persist(request.path, request.payload, request.method ?? "POST");
    if (error) put(layer, id, prev as typeof next);
    return error;
  }

  const override = (id: string) => get().overrides.get(id) ?? blank(id);
  const write = (id: string, change: Partial<WorkspaceOverride>, payload: Record<string, unknown>) => optimistic("overrides", id, { ...override(id), ...change }, { path: OVERRIDES_PATH, payload: { itemId: id, ...payload } });

  return {
    resources: [],
    archived: [],
    overrides: new Map(),
    personalState: new Map(),
    expandedId: null,
    setResources: (resources) => set({ resources }),
    setArchived: (archived) => set({ archived }),
    setOverrides: (rows) => set({ overrides: toMap(rows) }),
    setPersonalState: (rows) => set({ personalState: toMap(rows) }),
    setExpanded: (expandedId) => set({ expandedId }),
    setTransport: (deps) => {
      transport = deps;
    },

    // Setting a priority on a dismissed item clears the dismissal in the same write.
    updatePriority: (id, priority, reason) => write(id, { priorityOverride: priority, dismissedAt: null }, { priorityOverride: priority, reason, dismissedAt: null }),
    // The server also enforces that the assignee is a writer in the caller's org (a 403 rolls the assignment back).
    setOwner: (id, ownerUserId, ownerName) => write(id, { ownerUserId, ownerName: ownerUserId === null ? null : ownerName }, { ownerUserId }),
    // Dismiss hides the item from the active view into the stash. It leaves the priority alone: a priority is an owner's or admin's act with a reason, and a member's dismissal does not erase it (migration 0121).
    dismissResource: (id) => {
      const now = new Date(performance.timeOrigin + performance.now()).toISOString();
      return write(id, { dismissedAt: now }, { dismissedAt: now });
    },
    restoreDismissed: (id) => write(id, { dismissedAt: null }, { dismissedAt: null }),
    // WORKSPACE archive through the override layer: the platform item stays untouched.
    archiveResource: (id, reason, note) => write(id, { isArchived: true, archiveReason: reason, archiveNote: note, archivedAt: new Date(performance.timeOrigin + performance.now()).toISOString() }, { isArchived: true, archiveReason: reason, archiveNote: note }),
    restoreResource: (id, reason) => write(id, { isArchived: false, archiveReason: null, archiveNote: null, archivedAt: null }, { isArchived: false, reason }),
    // PERSONAL archive: this user only, no role gate, no required reason, no notification fan-out.
    archivePersonal: (id, note) => optimistic("personalState", id, { itemId: id, isArchived: true, archiveNote: note || null, archivedAt: new Date(performance.timeOrigin + performance.now()).toISOString() }, { path: PERSONAL_PATH, payload: { itemId: id, isArchived: true, archiveNote: note || null } }),
    restorePersonal: (id) => optimistic("personalState", id, null, { path: PERSONAL_PATH, payload: { itemId: id, isArchived: false, archiveNote: null } }),
  };
});
registerItemStateHydrator((data) => { const s = useItemStateStore.getState(); if (data.overrides) s.setOverrides(data.overrides); if (data.personalState) s.setPersonalState(data.personalState.map((r) => ({ itemId: r.legacyId || r.itemId, isArchived: r.isArchived, archiveNote: r.archiveNote, archivedAt: r.archivedAt }))); });
