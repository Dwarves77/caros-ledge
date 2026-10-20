// Ported from old_repo/src/components/settings/BriefingScheduleSection.tsx (lines 136-154)
// Ported from old_repo/src/components/settings/OrganisationProfileSection.tsx (lines 139-154)
// Ported from old_repo/src/stores/settingsStore.ts (lines 65-100)
import type { Db } from "@/core/db/clients";

/** The jsonb columns of workspace_settings: every writer patches them KEY-WISE (INV-168), never replaces them. */
const JSONB_COLUMNS = ["profile", "alert_config", "home_sections", "default_filters", "jurisdiction_weights"] as const;
/** Columns that are not objects: a single writer replaces the value. */
const REPLACE_COLUMNS = ["sector_profile", "default_export_format"] as const;
export type JsonbColumn = (typeof JSONB_COLUMNS)[number];
export type ReplaceColumn = (typeof REPLACE_COLUMNS)[number];
export type SettingsColumn = JsonbColumn | ReplaceColumn;

export interface PatchResult {
  /** The failure message, or null when the write landed. A caller must show it: a refused write never prints "Saved". */
  error: string | null;
  /** The value now stored in the column (null on failure). */
  value: unknown;
}

const isJsonb = (c: string): c is JsonbColumn => (JSONB_COLUMNS as readonly string[]).includes(c);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const NO_ROW = "This workspace has no settings row, or you may not change it.";

/**
 * The ONE writer of workspace_settings (INV-168). A jsonb column is patched by the database in one statement (rpc patch_workspace_settings,
 * migration 0023): it merges the caller's keys over the stored ones under the caller's own RLS, so two writers of different keys lose nothing
 * even at the same moment and no read-merge-write loop exists. `sector_profile` and `default_export_format` have a single writer, so the patch is
 * the new value. The allowlist of columns stays here. A failed write is returned, never thrown, and a write that changed nothing is an error.
 */
export async function patchWorkspaceSettings(client: Db, orgId: string, column: SettingsColumn, patch: unknown): Promise<PatchResult> {
  const fail = (error: string): PatchResult => ({ error, value: null });
  if (!orgId) return fail("No workspace is selected.");
  const jsonb = isJsonb(column);
  if (!jsonb && !(REPLACE_COLUMNS as readonly string[]).includes(column)) return fail(`${String(column)} is not a workspace setting.`);
  if (jsonb && !isObject(patch)) return fail(`${column} takes an object of keys to change.`);
  if (jsonb) {
    const { data, error } = await client.rpc("patch_workspace_settings", { p_org_id: orgId, p_column: column, p_patch: patch });
    if (error) return fail(error.message);
    return data === null || data === undefined ? fail(NO_ROW) : { error: null, value: data };
  }
  const { data, error } = await client.from("workspace_settings").update({ [column]: patch }).eq("org_id", orgId).select("org_id");
  if (error) return fail(error.message);
  return (data ?? []).length > 0 ? { error: null, value: patch } : fail(NO_ROW);
}
