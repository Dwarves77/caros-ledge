// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 311-388)
// The integrity-flag writer for the grounding path. A flag is deduped on (created_by, subject_ref) while open, so a re-ground does not
// re-open the same finding forever, and every database failure comes back as a NOTE (never swallowed): a flag that could not be
// written is reported in the run's notes.
import type { Db } from "@/core/db";

export interface FlagRow {
  category: string;
  subject_type: "item" | "source" | "system" | "surface" | "jurisdiction";
  subject_ref: string;
  created_by: string;
  description: string;
  recommended_actions?: { action: string; rationale: string; [k: string]: unknown }[];
}

/** Insert one open flag unless an open flag by the same producer on the same subject already exists. Returns a note on any failure, or null. */
export async function openFlagOnce(sb: Db, row: FlagRow): Promise<string | null> {
  const found = await sb.from("integrity_flags").select("id").eq("created_by", row.created_by).eq("subject_ref", row.subject_ref).eq("status", "open").limit(1);
  if (found.error) return `flag ${row.created_by} not written: dedupe read failed: ${found.error.message}`;
  if ((found.data ?? []).length) return null;
  const { error } = await sb.from("integrity_flags").insert({ ...row, description: row.description.slice(0, 480), recommended_actions: row.recommended_actions ?? [], status: "open" });
  return error ? `flag ${row.created_by} not written: ${error.message}` : null;
}
