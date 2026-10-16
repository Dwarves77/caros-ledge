// Ported from old_repo/src/lib/data.ts (lines 632-672)
// Ported from old_repo/src/lib/supabase-server.ts (lines 215-262)
import type { Db } from "@/core/db/clients";
import { boundedRead, fetchAllByIdChunks } from "@/core/db/query";
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

const ITEM = "id, legacy_id, title, item_type, domain";
type ItemRow = { id: string; legacy_id: string | null; title: string | null; item_type: string | null; domain: number | null };
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const uiId = (i: ItemRow) => i.legacy_id || i.id;
const link = (i: ItemRow): ItemLink => ({ title: i.title?.trim() || "Untitled item", href: detailHref({ id: uiId(i), type: i.item_type, domain: i.domain }) });
const failed = <T>(error: string): Section<T> => ({ rows: null, error, truncated: false });

type OverrideRow = { item_id: string; archive_reason: string | null; archive_note: string | null; archived_at: string | null; item: ItemRow | ItemRow[] | null };
type PersonalRow = { item_id: string; archive_note: string | null; archived_at: string | null; item: ItemRow | ItemRow[] | null };
type ReplacementRow = { old_item_id: string; new: ItemRow | ItemRow[] | null };

/** The items the signed-in reader has archived: the workspace's team archive and their own personal one, each with the replacement the item has, if any. */
async function readArchive(db: Db, who: { orgId: string | null; userId: string }): Promise<Section<ArchiveRow>> {
  const [team, personal] = await Promise.all([
    who.orgId
      ? boundedRead<OverrideRow>((limit) => db.from("workspace_item_overrides").select(`item_id, archive_reason, archive_note, archived_at, item:intelligence_items(${ITEM})`).eq("org_id", who.orgId as string).eq("is_archived", true).order("archived_at", { ascending: false }).order("item_id").limit(limit), { limit: 200 })
      : Promise.resolve({ data: [] as OverrideRow[], truncated: false, error: null }),
    boundedRead<PersonalRow>((limit) => db.from("user_item_state").select(`item_id, archive_note, archived_at, item:intelligence_items(${ITEM})`).eq("user_id", who.userId).eq("is_archived", true).order("archived_at", { ascending: false }).order("item_id").limit(limit), { limit: 200 }),
  ]);
  if (team.error) return failed(`workspace archive: ${team.error.message}`);
  if (personal.error) return failed(`personal archive: ${personal.error.message}`);

  const rows: ArchiveRow[] = [];
  const uuidOf = new Map<ArchiveRow, string>();
  const push = (row: ArchiveRow, uuid: string) => (rows.push(row), uuidOf.set(row, uuid));
  const seen = new Set<string>();
  for (const r of team.data) {
    const item = one(r.item);
    if (!item) continue;
    seen.add(r.item_id);
    push({ ...link(item), itemId: uiId(item), scope: "team", reason: r.archive_reason, note: r.archive_note, archivedAt: r.archived_at, replacement: null }, r.item_id);
  }
  // An item archived for the whole team is hidden by the wider scope; its personal row returns once the team archive is lifted.
  for (const r of personal.data) {
    const item = one(r.item);
    if (!item || seen.has(r.item_id)) continue;
    push({ ...link(item), itemId: uiId(item), scope: "personal", reason: null, note: r.archive_note, archivedAt: r.archived_at, replacement: null }, r.item_id);
  }

  const ids = [...new Set(uuidOf.values())];
  try {
    const found = await fetchAllByIdChunks(
      ids,
      async (slice) => {
        const { data, error } = await db.from("item_supersessions").select(`old_item_id, new:intelligence_items!item_supersessions_new_item_id_fkey(${ITEM})`).in("old_item_id", slice).order("supersession_date", { ascending: false });
        if (error) throw new Error(error.message);
        return (data ?? []) as ReplacementRow[];
      },
      { manyPerId: true },
    );
    const byOld = new Map<string, ItemLink>();
    for (const s of found) {
      const next = one(s.new);
      if (next && !byOld.has(s.old_item_id)) byOld.set(s.old_item_id, link(next));
    }
    for (const row of rows) row.replacement = byOld.get(uuidOf.get(row) ?? "") ?? null;
  } catch (e) {
    return failed(`replacements: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { rows, error: null, truncated: team.truncated || personal.truncated };
}

type SupersessionDb = { id: string; supersession_date: string; severity: string; note: string | null; old: ItemRow | ItemRow[] | null; new: ItemRow | ItemRow[] | null };

/** The most recent supersessions with both sides' titles (a raw identifier is never the title). */
async function readSupersessions(db: Db): Promise<Section<SupersessionRow>> {
  const r = await boundedRead<SupersessionDb>(
    (limit) => db.from("item_supersessions").select(`id, supersession_date, severity, note, old:intelligence_items!item_supersessions_old_item_id_fkey(${ITEM}), new:intelligence_items!item_supersessions_new_item_id_fkey(${ITEM})`).order("supersession_date", { ascending: false }).order("id").limit(limit),
    { limit: 200 },
  );
  if (r.error) return failed(`supersessions: ${r.error.message}`);
  const rows: SupersessionRow[] = [];
  for (const s of r.data) {
    const [o, n] = [one(s.old), one(s.new)];
    if (o && n) rows.push({ key: s.id, severity: s.severity, date: s.supersession_date, old: link(o), new: link(n), note: s.note ?? "" });
  }
  return { rows, error: null, truncated: r.truncated };
}

/** The /settings page's whole read: three bounded reads, in parallel, each reporting its own failure. Tables: workspace_item_overrides, user_item_state, item_supersessions, intelligence_items. */
export async function readSettingsData(db: Db, who: { orgId: string | null; userId: string }): Promise<SettingsData> {
  const [archive, supersessions] = await Promise.all([readArchive(db, who), readSupersessions(db)]);
  return { archive, supersessions };
}
