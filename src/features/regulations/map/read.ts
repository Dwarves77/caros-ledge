// Ported from old_repo/src/lib/supabase-server.ts (lines 3146-3262)
// Ported from old_repo/src/lib/data.ts (lines 592-631)
// The map's ONE read: the regulation rows with the five columns the map draws (code, priority, modes, topic, title), from the SAME listing RPC the Regulations list reads (the workspace's when the caller has one,
// the public one when not), so a retagged or archived item is the same band and the same count on the map and in the list (R2d, S:10). Cached per workspace; a failed read throws, so it is never cached and the page
// says it did not load.
import { INTEL_ITEMS_TAG, cachedRead, type CachedRead } from "@/core/cache";
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db/query";

import type { MapItem } from "./rollup";

const MAP_REVALIDATE_SECONDS = 300;
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

async function readMapItems(db: Db, orgId: string | null): Promise<MapItem[]> {
  const rpc = orgId ? "get_workspace_intelligence_listings" : "get_workspace_intelligence_listings_public";
  const args = { ...(orgId ? { p_org_id: orgId } : {}), p_domain: REGULATIONS_DOMAIN };
  const rows = await fetchAllRows<Row>((from, to) => db.rpc(rpc, args).range(from, to) as never, { pageSize: 500, cap: 20_000 });
  return rows
    .filter((r) => r.effective_archived !== true)
    .map((r) => ({ id: r.legacy_id || r.id, title: r.title, priority: r.effective_priority ?? r.priority ?? "", modes: r.transport_modes ?? [], topic: r.category ?? undefined, jurisdictionIso: r.jurisdiction_iso ?? undefined, jurisdiction: r.jurisdictions?.[0] ?? undefined }));
}

/** The cached read for the route, one entry per workspace (and one for the public read). */
export const getMapItems = (db: Db, orgId: string | null): Promise<CachedRead<MapItem[]>> => cachedRead(["regulations-map-items", orgId ?? "public"], () => readMapItems(db, orgId), { tags: [INTEL_ITEMS_TAG], revalidate: MAP_REVALIDATE_SECONDS });
