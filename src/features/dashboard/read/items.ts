// Ported from old_repo/src/lib/supabase-server.ts (lines 1213-1358)
// The by-id backfill every digest card and every portfolio reads through: the full row of each verified item, in chunks, with the columns a list row draws. One read shape, so a held portfolio member and a
// dashboard row can never disagree about the same item.
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import type { WorkspaceItemRpcRow } from "@/features/lists";

export const BACKFILL_COLUMNS = "id, legacy_id, title, summary, tags, domain, category, item_type, source_id, source_url, jurisdictions, transport_modes, verticals, priority, compliance_deadline, added_date, is_archived, item_grade, origin_class, last_regenerated_at, jurisdiction_iso";
export type FullRow = WorkspaceItemRpcRow & { verticals?: string[] | null };

/** The verified rows among `ids` (uuids), optionally only the unarchived ones. A failed chunk rejects the read. */
export async function readItemRows(db: Db, ids: readonly string[], opts: { unarchived?: boolean } = {}): Promise<FullRow[]> {
  return fetchAllByIdChunks(ids, async (slice) => {
    const base = db.from("intelligence_items").select(BACKFILL_COLUMNS).eq("provenance_status", "verified");
    const { data, error } = await (opts.unarchived ? base.eq("is_archived", false) : base).in("id", slice);
    if (error) throw new Error(`intelligence_items backfill failed: ${error.message}`);
    return (data ?? []) as unknown as FullRow[];
  });
}
