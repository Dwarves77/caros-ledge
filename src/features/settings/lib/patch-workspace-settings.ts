// Ported from old_repo/src/components/settings/BriefingScheduleSection.tsx (lines 136-154)
// Ported from old_repo/src/components/settings/OrganisationProfileSection.tsx (lines 139-154)
// Ported from old_repo/src/stores/settingsStore.ts (lines 65-100)
import type { Db } from "@/core/db/clients";

/** The jsonb columns of workspace_settings: every writer patches them KEY-WISE (INV-168), never replaces them. */
export const JSONB_COLUMNS = ["profile", "alert_config", "home_sections", "default_filters", "jurisdiction_weights"] as const;
/** Columns that are not objects: a single writer replaces the value. */
export const REPLACE_COLUMNS = ["sector_profile", "default_export_format"] as const;
export type JsonbColumn = (typeof JSONB_COLUMNS)[number];
export type ReplaceColumn = (typeof REPLACE_COLUMNS)[number];
export type SettingsColumn = JsonbColumn | ReplaceColumn;

export interface PatchResult {
  /** The failure message, or null when the write landed. A caller must show it: a refused write never prints "Saved". */
  error: string | null;
  /** The value now stored in the column (null on failure). */
  value: unknown;
}

const MAX_ATTEMPTS = 5;
const isJsonb = (c: string): c is JsonbColumn => (JSONB_COLUMNS as readonly string[]).includes(c);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The ONE writer of workspace_settings (INV-168). For a jsonb column it reads the row, merges the caller's keys over the stored ones, and
 * writes the result back only if the row is still the version it read (compare-and-swap on updated_at, which a trigger bumps on every
 * update): two writers of different keys therefore lose nothing, even when they run at the same moment, because the loser re-reads and
 * merges again. For `sector_profile` and `default_export_format` the patch is the new value. A failed read or write is returned, never thrown.
 */
export async function patchWorkspaceSettings(client: Db, orgId: string, column: SettingsColumn, patch: unknown): Promise<PatchResult> {
  const fail = (error: string): PatchResult => ({ error, value: null });
  if (!orgId) return fail("No workspace is selected.");
  const jsonb = isJsonb(column);
  if (!jsonb && !(REPLACE_COLUMNS as readonly string[]).includes(column)) return fail(`${String(column)} is not a workspace setting.`);
  if (jsonb && !isObject(patch)) return fail(`${column} takes an object of keys to change.`);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const { data, error } = await client.from("workspace_settings").select(`${column}, updated_at`).eq("org_id", orgId).maybeSingle();
    if (error) return fail(error.message);
    const row = data as Record<string, unknown> | null;
    if (!row) return fail("This workspace has no settings row yet.");
    const current = row[column];
    const next = jsonb ? { ...(isObject(current) ? current : {}), ...(patch as Record<string, unknown>) } : patch;
    const { data: written, error: writeError } = await client.from("workspace_settings").update({ [column]: next }).eq("org_id", orgId).eq("updated_at", row.updated_at).select("org_id");
    if (writeError) return fail(writeError.message);
    if ((written ?? []).length > 0) return { error: null, value: next };
    // Another writer changed the row between our read and our write: read it again and merge again.
  }
  return fail("The settings changed while saving. Try again.");
}
