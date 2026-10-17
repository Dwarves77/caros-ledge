// New in P2-13: the injection point for the one slice the Dashboard reads that is not merged here (WAVE-2-COMMON deps rule), no old counterpart.
import type { Db } from "@/core/db";
import type { ThemeChip } from "@/ui/list-surface";

/**
 * What the Dashboard calls into slices that are not merged. P2-10 supplies the cross-page theme view (`themeChips` of src/core/themes); until it is wired the "Connected across pages"
 * block simply has no themes to draw, and the startup check names the member as owed. It is never faked.
 */
export interface DashboardDeps {
  themeChips: (db: Db, opts: { minPages: number; max: number }) => Promise<ThemeChip[]>;
}

let wired: Partial<DashboardDeps> = {};

export function wireDashboardDeps(deps: Partial<DashboardDeps>): void {
  wired = { ...wired, ...deps };
}

export function dashboardDeps(): Partial<DashboardDeps> {
  return wired;
}
