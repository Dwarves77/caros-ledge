// Ported from old_repo/src/lib/supabase-server.ts (lines 2178-2270)
// The category surfaces' routed reads (market, research, operations): the whole corpus, paged 1000 under a total order. A failed page is a failure, not an empty list.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import type { Resource } from "@/core/types";
import { attachImpact } from "@/core/impact/attach";

import { enrichSources } from "./enrich";
import { categoryResourceFields, type WorkspaceItemRpcRow } from "./map-rows";

export type CategoryRpc = "get_market_intel_items" | "get_research_items" | "get_operations_items" | "get_market_intel_items_public" | "get_research_items_public" | "get_operations_items_public";
const PAGE = 1000;
const CAP = 20_000;

/** `impactOrgId` is the reading workspace for the client dimension of each row's impact (the public RPCs take no org; the scores are read for the member's own workspace). */
export async function readCategory(db: Db, rpc: CategoryRpc, orgId?: string | null, impactOrgId: string | null = orgId ?? null): Promise<{ resources: Resource[]; total: number; failed: boolean }> {
  const args = orgId ? { p_org_id: orgId } : {};
  try {
    const rows = (await fetchAllRows((from, to) => db.rpc(rpc, args).range(from, to), { pageSize: PAGE, cap: CAP })) as WorkspaceItemRpcRow[];
    const resources = rows.map(categoryResourceFields);
    await Promise.all([
      enrichSources(db, resources, { biasTags: true }),
      (async () => await attachImpact(db, resources, new Map(rows.map((r) => [r.legacy_id || r.id, r.id])), impactOrgId))(),
    ]);
    return { resources, total: rows.length, failed: false };
  } catch {
    return { resources: [], total: 0, failed: true };
  }
}
