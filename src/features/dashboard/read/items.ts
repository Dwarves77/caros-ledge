// Ported from old_repo/src/lib/supabase-server.ts (lines 1213-1358)
// The by-id backfill every digest card and every portfolio reads through: the rows of the named items AS THE WORKSPACE SEES THEM (get_workspace_items_by_ids, migration 0095: admissible items with the workspace's
// priority override and archive applied by the database, the rule the list RPCs apply), in chunks. One read shape, so a held portfolio member and a dashboard row can never disagree about the same item.
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import type { WorkspaceItemRpcRow } from "@/features/lists";

export type FullRow = WorkspaceItemRpcRow & { verticals?: string[] | null };

/** The workspace's rows for the named uuids; an id the workspace cannot see (archived, replaced, unverified, unknown) is absent. A failed chunk rejects the read. */
export async function readItemRows(db: Db, orgId: string, ids: readonly string[]): Promise<FullRow[]> {
  return fetchAllByIdChunks(ids, async (slice) => {
    const { data, error } = await db.rpc("get_workspace_items_by_ids", { p_org_id: orgId, p_ids: slice });
    if (error) throw new Error(`get_workspace_items_by_ids failed: ${error.message}`);
    return (data ?? []) as unknown as FullRow[];
  });
}
