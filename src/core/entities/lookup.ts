// The one lookup of entities by kind and of regions (IMP-053): the producers that resolve a name or a code to an id read them here, paged under a total order with a cap, never one unbounded read that silently truncates.
import { fetchAllRows, qb, type Db } from "@/core/db";

export interface EntityName {
  entity_id: string;
  canonical_name: string;
}
export interface RegionCode {
  id: string;
  code: string;
}

/** Every entity of a kind (entity_id and canonical_name), in entity_id order. A failed page throws. */
export function entitiesByKind(sb: Db, kind: string): Promise<EntityName[]> {
  return fetchAllRows<EntityName>((from, to) => qb<EntityName>(sb.from("entities").select("entity_id, canonical_name")).eq("kind", kind).order("entity_id", { ascending: true }).range(from, to), { cap: 100_000 });
}

/** Every region (id and code), in id order. A failed page throws. */
export function regionCodes(sb: Db): Promise<RegionCode[]> {
  return fetchAllRows<RegionCode>((from, to) => qb<RegionCode>(sb.from("regions").select("id, code")).order("id", { ascending: true }).range(from, to), { cap: 10_000 });
}
