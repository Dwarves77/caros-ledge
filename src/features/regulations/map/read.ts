// Ported from old_repo/src/lib/supabase-server.ts (lines 3146-3262)
// Ported from old_repo/src/lib/data.ts (lines 592-631)
// The map's ONE read: the regulation rows with the five columns the map draws (code, priority, modes, topic, title), from the SAME listing RPC the Regulations list reads (the workspace's when the caller has one,
// the public one when not), so a retagged or archived item is the same band and the same count on the map and in the list (R2d, S:10). Read live on every request, never cached: a page may not draw a count that the data has since changed (the 2026-10-20 quarantine showed old
// region counts for hours). A failed read throws, so the page says it did not load and never draws an empty map.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db/query";

import type { MapItem } from "./rollup";

const REGULATIONS_DOMAIN = 1;

interface Row {
  id: string;
  legacy_id: string | null;
  title: string;
  effective_priority?: string | null;
  priority?: string | null;
  effective_archived?: boolean | null;
  jurisdictions: string[] | null;
  jurisdiction_iso: string[] | null;
  transport_modes: string[] | null;
  category: string | null;
}

export async function getMapItems(db: Db, orgId: string | null): Promise<MapItem[]> {
  const rpc = orgId ? "get_workspace_intelligence_listings" : "get_workspace_intelligence_listings_public";
  const args = { ...(orgId ? { p_org_id: orgId } : {}), p_domain: REGULATIONS_DOMAIN };
  const rows = await fetchAllRows<Row>((from, to) => db.rpc(rpc, args).range(from, to) as never, { pageSize: 500, cap: 20_000 });
  return rows
    .filter((r) => r.effective_archived !== true)
    .map((r) => ({ id: r.legacy_id || r.id, title: r.title, priority: r.effective_priority ?? r.priority ?? "", modes: r.transport_modes ?? [], topic: r.category ?? undefined, jurisdictionIso: r.jurisdiction_iso ?? undefined, jurisdiction: r.jurisdictions?.[0] ?? undefined }));
}

