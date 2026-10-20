"use client";

// Ported from old_repo/src/stores/settingsStore.ts (lines 14-60)
// Ported from old_repo/src/stores/settingsStore.ts (lines 138-189)
// Ported from old_repo/src/stores/settingsStore.ts (lines 206-261)
import { create } from "zustand";

import { readFailure } from "@/core/http/failure";
import { browserClient } from "@/core/db/browser";
import type { Db } from "@/core/db/clients";
import { log } from "@/core/shared/log";
import { patchWorkspaceSettings, type SettingsColumn } from "@/core/workspace/settings";
import { useWorkspaceStore } from "@/core/workspace/store";

// The six dashboard regions (artboard 15). Settings persist per workspace in workspace_settings: home_sections, default_export_format,
// alert_config and default_filters. Every write goes through patchWorkspaceSettings (key-wise, INV-168) and the store is LOADED once per
// org from the workspace store (B-0665: the old store had a persistence path and no loader call, so nothing ever loaded or saved).
export type DashboardRegionKey = "BandTiles" | "DueNext" | "WhatChanged" | "WatchlistRail" | "AcrossPlatform" | "Supersessions";
export type SortKey = "next-date" | "newest" | "az" | "my-order";
export type BriefingDay = "monday" | "tuesday" | "wednesday" | "thursday" | "friday";

const REGION_KEY: Record<DashboardRegionKey, { field: string; stored: string; legacy: string }> = {
  BandTiles: { field: "showBandTiles", stored: "bandTiles", legacy: "summaryStrip" },
  DueNext: { field: "showDueNext", stored: "dueNext", legacy: "dueThisQuarter" },
  WhatChanged: { field: "showWhatChanged", stored: "whatChanged", legacy: "whatChanged" },
  WatchlistRail: { field: "showWatchlistRail", stored: "watchlistRail", legacy: "topUrgency" },
  AcrossPlatform: { field: "showAcrossPlatform", stored: "acrossPlatform", legacy: "weeklyBriefing" },
  Supersessions: { field: "showSupersessions", stored: "supersessions", legacy: "supersessions" },
};
const SAVE_DELAY_MS = 1000;

interface SettingsState {
  showBandTiles: boolean;
  showDueNext: boolean;
  showWhatChanged: boolean;
  showWatchlistRail: boolean;
  showAcrossPlatform: boolean;
  showSupersessions: boolean;
  /** The list surfaces' own sort vocabulary, not a second scale. */
  defaultSort: SortKey;
  exportFormat: "html" | "slack";
  briefingDay: BriefingDay;
  alertPriorities: string[];
  /** The stored alert_config and profile objects (the sections read their own keys from them) and the workspace's sectors, as the database holds them. */
  alertConfig: Record<string, unknown>;
  profile: Record<string, unknown>;
  sectorProfile: string[];
  /** The org these settings were loaded for; null until a read succeeded, so no save can overwrite a row that was never read. */
  orgId: string | null;
  loaded: boolean;
  loadError: string | null;
  /** The last save failure, shown by the settings page; null after a successful save. */
  saveError: string | null;
  toggleSection: (section: DashboardRegionKey) => void;
  setDefaultSort: (sort: SortKey) => void;
  setExportFormat: (format: "html" | "slack") => void;
  setBriefingDay: (day: BriefingDay) => void;
  setAlertPriorities: (priorities: string[]) => void;
  loadFromWorkspace: (client: Db, orgId: string) => Promise<void>;
  /**
   * Write one settings column NOW through the one writer (not debounced): the failure message, or null when it landed. The local copy follows what the
   * database stored, so a refused write never leaves the screen saying "saved". Sections never write the table themselves.
   */
  commit: (column: SettingsColumn, patch: unknown) => Promise<string | null>;
  /** Write whatever is pending now (the debounce timer calls this; tests and unmount call it directly). */
  flush: () => Promise<void>;
}

/** A region flag from a persisted home_sections object: the current key, else the pre-rebuild key the region used to be stored under, else on. */
function readRegion(hs: Record<string, unknown> | null | undefined, stored: string, legacy: string): boolean {
  if (!hs) return true;
  if (typeof hs[stored] === "boolean") return hs[stored] as boolean;
  return typeof hs[legacy] === "boolean" ? (hs[legacy] as boolean) : true;
}

const SORTS = new Set<string>(["next-date", "newest", "az", "my-order"]);
/** The pre-rebuild sort values map onto the list surfaces' real sorts. */
function readSortKey(value: unknown): SortKey | null {
  if (typeof value === "string" && SORTS.has(value)) return value as SortKey;
  if (value === "urgency" || value === "priority") return "next-date";
  if (value === "alpha") return "az";
  if (value === "added" || value === "modified") return "newest";
  return null;
}

let provider: () => Db = browserClient;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Pending key changes per column; a later change to the same key wins. */
let pending = new Map<SettingsColumn, Record<string, unknown>>();

export const useSettingsStore = create<SettingsState>((set, get) => {
  const queue = (column: SettingsColumn, patch: Record<string, unknown>) => {
    if (!get().orgId) return; // never loaded for an org, so there is nothing safe to write over
    pending.set(column, { ...(pending.get(column) ?? {}), ...patch });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void get().flush(), SAVE_DELAY_MS);
  };

  return {
    showBandTiles: true,
    showDueNext: true,
    showWhatChanged: true,
    showWatchlistRail: true,
    showAcrossPlatform: true,
    showSupersessions: true,
    defaultSort: "next-date",
    exportFormat: "html",
    briefingDay: "monday",
    alertPriorities: ["CRITICAL", "HIGH"],
    alertConfig: {},
    profile: {},
    sectorProfile: [],
    orgId: null,
    loaded: false,
    loadError: null,
    saveError: null,

    toggleSection: (section) => {
      const { field, stored } = REGION_KEY[section];
      const value = !(get() as unknown as Record<string, boolean>)[field];
      set({ [field]: value } as Partial<SettingsState>);
      queue("home_sections", { [stored]: value });
    },
    setDefaultSort: (defaultSort) => {
      set({ defaultSort });
      queue("default_filters", { defaultSort });
    },
    setExportFormat: (exportFormat) => {
      set({ exportFormat });
      queue("default_export_format", { value: exportFormat });
    },
    setBriefingDay: (briefingDay) => {
      set({ briefingDay });
      queue("alert_config", { briefingDay });
    },
    setAlertPriorities: (alertPriorities) => {
      set({ alertPriorities });
      queue("alert_config", { priorities: alertPriorities });
    },

    async commit(column, patch) {
      const orgId = get().orgId;
      if (!orgId) return "This workspace's settings have not loaded, so nothing was saved.";
      const result = await patchWorkspaceSettings(provider(), orgId, column, patch);
      if (result.error) return result.error;
      const stored = result.value as Record<string, unknown>;
      if (column === "alert_config") set({ alertConfig: stored, ...(Array.isArray(stored.priorities) ? { alertPriorities: stored.priorities as string[] } : {}), ...(typeof stored.briefingDay === "string" ? { briefingDay: stored.briefingDay as BriefingDay } : {}) });
      else if (column === "profile") set({ profile: stored });
      else if (column === "sector_profile") {
        set({ sectorProfile: patch as string[] });
        useWorkspaceStore.getState().setSectorProfile(patch as string[]);
      }
      return null;
    },

    async flush() {
      if (timer) clearTimeout(timer);
      timer = null;
      const orgId = get().orgId;
      const batch = pending;
      pending = new Map();
      if (!orgId || batch.size === 0) return;
      let failure: string | null = null;
      for (const [column, patch] of batch) {
        const result = await patchWorkspaceSettings(provider(), orgId, column, column === "default_export_format" ? patch.value : patch);
        if (result.error) {
          failure = result.error;
          log.warn(`[settings-store] ${column} save failed (the change stays on this screen only): ${result.error}`);
        }
      }
      set({ saveError: failure });
    },

    async loadFromWorkspace(client, orgId) {
      const { data, error } = await client.from("workspace_settings").select("home_sections, default_export_format, alert_config, default_filters, profile, sector_profile").eq("org_id", orgId).maybeSingle();
      // A failed read shows the defaults for this session and leaves orgId unset, so no save can overwrite the stored row with them.
      if (error) {
        log.warn(`[settings-store] workspace_settings read failed (defaults shown, saves held): ${error.message}`);
        set({ orgId: null, loaded: true, loadError: readFailure(error) });
        return;
      }
      if (!data) {
        set({ orgId, loaded: true, loadError: null });
        return;
      }
      const hs = data.home_sections as Record<string, unknown> | null;
      const ac = data.alert_config as { priorities?: string[]; briefingDay?: BriefingDay } | null;
      const sort = readSortKey((data.default_filters as { defaultSort?: unknown } | null)?.defaultSort);
      const regions = Object.fromEntries(Object.values(REGION_KEY).map((r) => [r.field, readRegion(hs, r.stored, r.legacy)]));
      set({
        orgId,
        loaded: true,
        loadError: null,
        alertConfig: (ac as Record<string, unknown> | null) ?? {},
        profile: (data.profile as Record<string, unknown> | null) ?? {},
        sectorProfile: (data.sector_profile as string[] | null) ?? [],
        ...(hs ? regions : {}),
        ...(data.default_export_format ? { exportFormat: data.default_export_format as "html" | "slack" } : {}),
        ...(ac?.priorities ? { alertPriorities: ac.priorities } : {}),
        ...(ac?.briefingDay ? { briefingDay: ac.briefingDay } : {}),
        ...(sort ? { defaultSort: sort } : {}),
      });
    },
  };
});

/**
 * Load the settings ONCE per org, from the workspace store's org id (the loader call B-0665 was missing), and again only when the org
 * changes. Returns the unsubscribe. `clientFor` supplies the RLS-bound browser client (a test passes a fake).
 */
export function bindSettingsToWorkspace(clientFor: () => Db = browserClient): () => void {
  provider = clientFor;
  let loadingFor: string | null = null;
  const loadFor = (orgId: string | null) => {
    if (!orgId) return;
    const state = useSettingsStore.getState();
    if (state.orgId === orgId || loadingFor === orgId) return;
    loadingFor = orgId;
    void state.loadFromWorkspace(clientFor(), orgId).finally(() => {
      loadingFor = null;
    });
  };
  loadFor(useWorkspaceStore.getState().orgId);
  return useWorkspaceStore.subscribe((s, prev) => {
    if (s.orgId !== prev.orgId) loadFor(s.orgId);
  });
}

/** Load again after a failed read (the Retry of a section or the page). */
export function reloadSettings(): void {
  const orgId = useWorkspaceStore.getState().orgId;
  if (orgId) void useSettingsStore.getState().loadFromWorkspace(provider(), orgId);
}

if (typeof window !== "undefined") bindSettingsToWorkspace();
