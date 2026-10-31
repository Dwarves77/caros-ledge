// Ported from old_repo/src/lib/connections/run-discovery.mjs (lines 5-35)
// Ported from old_repo/scripts/connections/apply-tags.mjs (lines 497-502)
// Ported from old_repo/scripts/connections/discover-for-items.mjs (lines 99-106)
// Ported from old_repo/src/lib/connections/signal-candidates.mjs (lines 9-21)
// ONE connection signature and ONE paged loader. The signature carries the domain, so surfaceOf is always called with (item_type, domain). ENGINE-JOIN-1: entity_ids are the SPECIFIC entities the item is filed under (entity_refs, plus its instrument entity; a bare mode,
// jurisdiction or organisation joins nothing), hops are the entities one entity_relations edge away from them (with the relation token), and entity_names carries the canonical name of each for the evidence a reader is shown. The regulation identifier in a title
// (the old decisive signal) is only the fallback for an item with no refs at all. obligation_keys are the ids of the obligation objects the item holds (and the ones they supersede).
import { admitItems } from "@/core/derived/admissible";
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";

import { classOfRole, entityRefs, isGenericEntity, neighbours, refsOfRows, relationsAround } from "./facts-join";

/** An entity one relation away from one the item is filed under. */
export interface HopRef {
  entity_id: string;
  via: string;
  relation: string;
  via_is_parent: boolean;
}
export interface Signature {
  id: string;
  item_type?: string | null;
  domain?: number | null;
  title?: string | null;
  canonical_instrument_key?: string | null;
  instrument_entity_id?: string | null;
  source_id?: string | null;
  operational_scenario_tags?: string[] | null;
  compliance_object_tags?: string[] | null;
  jurisdictions?: string[] | null;
  jurisdiction_iso?: string[] | null;
  topic_tags?: string[] | null;
  created_at?: string | null;
  entity_ids?: string[];
  hops?: HopRef[];
  /** The classes (instrument, feedstock, carrier, node, ...) of the entities the item is filed under, from the role of each ref. */
  entity_classes?: string[];
  entity_names?: ReadonlyMap<string, string>;
  obligation_keys?: string[];
}

export const SIGNATURE_COLUMNS =
  "id, item_type, domain, title, canonical_instrument_key, instrument_entity_id, source_id, operational_scenario_tags, compliance_object_tags, jurisdictions, jurisdiction_iso, topic_tags, created_at";
export const SIGNATURE_CAP = 200_000;

// The EU instrument forms only: "Regulation (EU) 2023/1805", "No 1907/2006", "Directive 2012/27/EU". A season string ("2025/26") is none.
const REG_ID_RE = /(?:\(EU\)|\(EC\)|\(EEC\)|No\.?)\s*(\d{4}\/\d{1,5}|\d{1,5}\/\d{4})|\b(\d{4}\/\d{1,5})\/(?:EU|EC|EEC)\b/g;

/** Regulation identifiers (2023/1805) named in a title, each as an entity token. */
function regulationEntityTokens(title: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of String(title ?? "").matchAll(REG_ID_RE)) out.add(`reg:${m[1] ?? m[2]}`);
  return [...out].sort();
}

/** The rows with the entity graph attached: batched reads of their refs, the relations around them and the names; no per-item query. */
export async function withEntityGraph(sb: Db, rows: readonly Signature[]): Promise<Signature[]> {
  const refs = await refsOfRows(sb, "intelligence_items", rows.map((r) => r.id));
  const filed = new Map<string, { entity: string; cls: string }[]>();
  const anyRef = new Set<string>();
  for (const r of refs) {
    anyRef.add(r.ref_id);
    if (!isGenericEntity(r.entity_id, r.role)) filed.set(r.ref_id, [...(filed.get(r.ref_id) ?? []), { entity: r.entity_id, cls: classOfRole(r.role) }]);
  }
  for (const r of rows) if (r.instrument_entity_id) filed.set(r.id, [...(filed.get(r.id) ?? []), { entity: r.instrument_entity_id, cls: "instrument" }]);
  const direct = new Set([...filed.values()].flatMap((l) => l.map((x) => x.entity)));
  const near = neighbours(await relationsAround(sb, direct));
  const names = new Map([...(await entityRefs(sb, [...direct, ...[...direct].flatMap((e) => (near.get(e) ?? []).map((n) => n.entity))])).values()].map((e) => [e.id, e.canonicalName]));
  return rows.map((r) => {
    const mine = filed.get(r.id) ?? [];
    const ids = [...new Set(mine.map((x) => x.entity))].sort();
    const hops = ids.flatMap((e) => (near.get(e) ?? []).filter((n) => !ids.includes(n.entity)).map((n) => ({ entity_id: n.entity, via: e, relation: n.relation, via_is_parent: n.asParent })));
    return { ...r, entity_ids: anyRef.has(r.id) ? ids : [...new Set([...ids, ...regulationEntityTokens(r.title)])], hops, entity_classes: [...new Set(mine.map((x) => x.cls))].sort(), entity_names: names };
  });
}

/**
 * The verified, live corpus as signatures, id-ordered (a total order) and capped. A failed page throws: discovery over a half-read
 * corpus would score against the wrong frequencies. `ids` restricts to those items, `since` to rows created at or after it.
 */
export async function loadSignatures(sb: Db, opts: { ids?: readonly string[]; since?: string; excludeId?: string; withObligations?: boolean } = {}): Promise<Signature[]> {
  const rows = await fetchAllRows<Signature>(
    (from, to) => {
      let q = admitItems(sb.from("intelligence_items").select(SIGNATURE_COLUMNS));
      if (opts.excludeId) q = q.neq("id", opts.excludeId);
      if (opts.ids?.length) q = q.in("id", [...opts.ids]);
      if (opts.since) q = q.gte("created_at", opts.since);
      return q.order("id", { ascending: true }).range(from, to);
    },
    { cap: SIGNATURE_CAP },
  );
  const keys = opts.withObligations === false ? new Map<string, string[]>() : await loadObligationKeys(sb);
  return (await withEntityGraph(sb, rows)).map((r) => ({ ...r, obligation_keys: keys.get(r.id) ?? [] }));
}

/** Item id to the obligation keys it holds: each object's id and the id it supersedes (so a new version links to the one it replaced). */
export async function loadObligationKeys(sb: Db): Promise<Map<string, string[]>> {
  const objs = await fetchAllRows<{ obligation_id: string; instrument_item_id: string; supersedes: string | null }>(
    (from, to) => sb.from("obligation_objects").select("obligation_id, instrument_item_id, supersedes").order("obligation_id", { ascending: true }).range(from, to),
    { cap: SIGNATURE_CAP },
  );
  const out = new Map<string, Set<string>>();
  for (const o of objs) {
    const set = out.get(o.instrument_item_id) ?? new Set<string>();
    set.add(o.obligation_id);
    if (o.supersedes) set.add(o.supersedes);
    out.set(o.instrument_item_id, set);
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}
