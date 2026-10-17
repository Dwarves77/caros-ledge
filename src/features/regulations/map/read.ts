// Ported from old_repo/src/lib/supabase-server.ts (lines 3146-3262)
// Ported from old_repo/src/lib/data.ts (lines 592-631)
// The map's ONE read: the regulation rows with the five columns the map draws (code, priority, modes, topic, title), public and cached for everyone (the published items are readable without an
// identity), never the whole workspace corpus plus every changelog, dispute and supersession the old read fetched. A failed read throws, so it is never cached and the page says it did not load.
import { unstable_cache } from "next/cache";

import { INTEL_ITEMS_TAG } from "@/core/cache";
import { anonClient, type Db } from "@/core/db";
import { fetchAllRows } from "@/core/db/query";

import type { MapItem } from "./rollup";

export const MAP_REVALIDATE_SECONDS = 300;
const REGULATIONS_DOMAIN = 1;
const COLUMNS = "id, legacy_id, title, priority, jurisdictions, jurisdiction_iso, transport_modes, category";

interface Row {
  id: string;
  legacy_id: string | null;
  title: string;
  priority: string;
  jurisdictions: string[] | null;
  jurisdiction_iso: string[] | null;
  transport_modes: string[] | null;
  category: string | null;
}

export async function readMapItems(db: Db = anonClient()): Promise<MapItem[]> {
  const rows = await fetchAllRows<Row>((from, to) => db.from("intelligence_items").select(COLUMNS).eq("domain", REGULATIONS_DOMAIN).eq("provenance_status", "verified").eq("is_archived", false).order("id", { ascending: true }).range(from, to) as never, { pageSize: 1000, cap: 20_000 });
  return rows.map((r) => ({ id: r.legacy_id || r.id, title: r.title, priority: r.priority, modes: r.transport_modes ?? [], topic: r.category ?? undefined, jurisdictionIso: r.jurisdiction_iso ?? undefined, jurisdiction: r.jurisdictions?.[0] ?? undefined }));
}

/** The cached public read for the route. */
export const getMapItems = unstable_cache(() => readMapItems(), ["regulations-map-items"], { revalidate: MAP_REVALIDATE_SECONDS, tags: [INTEL_ITEMS_TAG] });
