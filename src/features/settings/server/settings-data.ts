// Ported from old_repo/src/lib/data.ts (lines 632-672)
// Ported from old_repo/src/lib/supabase-server.ts (lines 215-262)
// The /settings page's whole read is ONE call: load_settings_bundle (migration 0038) answers the team archive, the personal archive, the replacements of the archived items and the supersessions together.
import { isMissingObject } from "@/core/db/absent";
import { LOOKUP_SENTENCE } from "@/core/http/errors";
import { refusalSentence } from "@/core/http/failure";
import { log } from "@/core/shared/log";
import type { Db } from "@/core/db/clients";
import { detailHref } from "@/core/lists";
import type { ArchiveRow, ItemLink } from "@/features/workspace/archive-types";

export interface SupersessionRow {
  key: string;
  severity: string;
  date: string;
  old: ItemLink;
  new: ItemLink;
  note: string;
}
/** A section is its rows or the reason it could not be read: a failed read is never an empty list (INV-263). */
export type Section<T> = { rows: T[]; error: null; truncated: boolean } | { rows: null; error: string; truncated: false };
export interface SettingsData {
  archive: Section<ArchiveRow>;
  supersessions: Section<SupersessionRow>;
}

const LIMIT = 200;
type ItemRow = { id: string; legacy_id: string | null; title: string | null; item_type: string | null; domain: number | null };
const uiId = (i: ItemRow) => i.legacy_id || i.id;
const link = (i: ItemRow): ItemLink => ({ title: i.title?.trim() || "Untitled item", href: detailHref({ id: uiId(i), type: i.item_type, domain: i.domain }) });
const failed = <T>(error: string): Section<T> => ({ rows: null, error, truncated: false });

/** The bundle as the function returns it. */
interface Bundle {
  overrides: { item_id: string; archive_reason: string | null; archive_note: string | null; archived_at: string | null; item: ItemRow }[];
  personal: { item_id: string; archive_note: string | null; archived_at: string | null; item: ItemRow }[];
  supersessions: { id: string; supersession_date: string; severity: string; note: string | null; old: ItemRow; new: ItemRow }[];
  history: { old_item_id: string; new: ItemRow }[];
  truncated: { overrides: boolean; personal: boolean; supersessions: boolean };
}

/** The archive the signed-in reader has: the workspace's team archive and their own personal one, each with the replacement the item has, if any. A team archive hides the personal row for the same item. */
function archiveOf(b: Bundle): Section<ArchiveRow> {
  const replacement = new Map(b.history.map((h) => [h.old_item_id, link(h.new)]));
  const team = b.overrides.map((r): ArchiveRow => ({ ...link(r.item), itemId: uiId(r.item), scope: "team", reason: r.archive_reason, note: r.archive_note, archivedAt: r.archived_at, replacement: replacement.get(r.item_id) ?? null }));
  const seen = new Set(b.overrides.map((r) => r.item_id));
  const personal = b.personal.filter((r) => !seen.has(r.item_id)).map((r): ArchiveRow => ({ ...link(r.item), itemId: uiId(r.item), scope: "personal", reason: null, note: r.archive_note, archivedAt: r.archived_at, replacement: replacement.get(r.item_id) ?? null }));
  return { rows: [...team, ...personal], error: null, truncated: b.truncated.overrides || b.truncated.personal };
}

/** The /settings page's whole read: one call, two sections. A failed or absent call fails both sections with its reason (INV-263); the page draws each as a failed block with Retry. */
export async function readSettingsData(db: Db, who: { orgId: string | null; userId: string }): Promise<SettingsData> {
  const { data, error } = await db.rpc("load_settings_bundle", { p_org_id: who.orgId, p_user_id: who.userId, p_limit: LIMIT });
  if (error || !data) {
    log.warn("[settings] load_settings_bundle failed:", error?.message ?? "the bundle was empty");
    const sentence = isMissingObject(error) ? refusalSentence("section_not_available") : LOOKUP_SENTENCE;
    return { archive: failed(sentence), supersessions: failed(sentence) };
  }
  const b = data as Bundle;
  const rows = b.supersessions.map((s): SupersessionRow => ({ key: s.id, severity: s.severity, date: s.supersession_date, old: link(s.old), new: link(s.new), note: s.note ?? "" }));
  return { archive: archiveOf(b), supersessions: { rows, error: null, truncated: b.truncated.supersessions } };
}
