// Entity-ref mining over the full corpus (C2). Refs are written only from FORMAL CODES and FOREIGN KEYS, never from words (ADR-053; NO-ENTITY-LISTS-1, operator 2026-10-26), each with a basis and the version of the rule that read it:
// (a) CLAIMS: every section_claim_provenance row's text read for formal codes only (an instrument identifier, a UN/LOCODE; resolveText), basis {claim_id, span, claim_kind, how}; an item is filed under the union of its claims' refs (basis {claim_id, how: union_of_claims});
// (b) TYPED COLUMNS: the column-to-entity mapping of couplings.json over the typed tables (an entity id held in a column, a closed transport-mode token, or the refs another table's row already holds through a foreign key), basis {table, pk, column, value};
//     a ref copied through a foreign key also carries inherited_from_item (or inherited_from_claim), so it is distinguishable from a resolved one. An obligation and a forward event are filed under their item's refs.
// A table keyed by text (obligation_objects) is keyed in entity_refs by the uuid of its key (uuidOf), the key itself in the basis. Idempotent: a second run writes no ref; a dry run counts the refs it would write.
// NOTHING IS DELETED: a ref is never retired because its entity is absent from a file or its basis looks like prose; the ontology is the database, and retirement is a decision of a ruled lane, not of this pass.
import { createHash } from "node:crypto";

import { normaliseMode } from "@/core/contracts/vocabularies";
import type { Db } from "@/core/db";
import type { RunResult } from "@/core/types/run-result";

import { COLUMNS, type ColumnMap } from "./coupling";
import { ontologyOf, type Ontology } from "./ontology";
import { readAll, type Row } from "./read";
import { buildResolver, resolveText, type Resolver } from "./resolve";

const REFS_VERSION = "refs@3.0.0";
const REFS_ASSERTED_BY = "coupling/refs";
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_ID_SHAPE = /^cl:[a-z_]+:[0-9a-f]{16}$/;
/** The basis key a ref copied through a foreign key carries, by the table it was copied from. */
/** An item is filed under the instrument entity its own column holds (a typed foreign key); the union of its claims' refs is added beside it. Defined here, not in couplings.json: the item table carries dozens of text columns that file nothing. */
const ITEM_MAP: ColumnMap = { table: "intelligence_items", pk: "id", maps: [{ column: "instrument_entity_id", by: "entity" }] };
const INHERIT_KEY: Record<string, string> = { intelligence_items: "inherited_from_item", section_claim_provenance: "inherited_from_claim" };

export interface RefRow {
  ref_table: string;
  ref_id: string;
  entity_id: string;
  role: string;
  asserted_by: string;
  basis: Record<string, unknown>;
  method_version: string;
}
const refKey = (r: Pick<RefRow, "ref_table" | "ref_id" | "entity_id" | "role">): string => `${r.ref_table}|${r.ref_id}|${r.entity_id}|${r.role}`;
/** The uuid a text key stands for in entity_refs.ref_id (the first 128 bits of its sha256, shaped as a uuid). */
export function uuidOf(key: string): string {
  const h = createHash("sha256").update(key, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
const refRow = (table: string, id: string, entity: string, basis: Record<string, unknown>, onto: Ontology): RefRow => ({ ref_table: table, ref_id: id, entity_id: entity, role: onto.roleOf(entity), asserted_by: REFS_ASSERTED_BY, basis, method_version: REFS_VERSION });

export interface MineContext {
  resolver: Resolver;
  /** The entities that exist: a ref to any other is refused by the foreign key, so none is planned. */
  known: ReadonlySet<string>;
  /** The kind of each entity that exists, for the counts by kind. */
  kinds: ReadonlyMap<string, string>;
  /** The refs held so far, `${ref_table}|${ref_id}` to entity ids: what a `refs` mapping copies. */
  held: Map<string, string[]>;
  /** The class, role and mode tokens of the entities, as the database holds them. */
  onto: Ontology;
}

/** (a) The refs of a list of claims by formal code, the refs those put on the claims' items, and the claims that resolved to nothing by kind. Pure. */
function claimRefs(claims: readonly { id: string; claim_text: string; claim_kind: string; intelligence_item_id?: string | null }[], c: MineContext): { refs: RefRow[]; itemRefs: RefRow[]; resolved: number; unresolved: Record<string, number> } {
  const refs: RefRow[] = [];
  const itemRefs: RefRow[] = [];
  const unresolved: Record<string, number> = {};
  let resolved = 0;
  for (const cl of claims) {
    const hits = resolveText(cl.claim_text, c.resolver).filter((m) => c.known.has(m.entityId));
    if (!hits.length) unresolved[cl.claim_kind] = (unresolved[cl.claim_kind] ?? 0) + 1;
    else resolved += 1;
    for (const m of hits) {
      refs.push(refRow("section_claim_provenance", cl.id, m.entityId, { claim_id: cl.id, span: m.span, claim_kind: cl.claim_kind, how: m.how }, c.onto));
      if (cl.intelligence_item_id) itemRefs.push(refRow("intelligence_items", cl.intelligence_item_id, m.entityId, { claim_id: cl.id, claim_kind: cl.claim_kind, how: "union_of_claims" }, c.onto));
    }
  }
  return { refs, itemRefs, resolved, unresolved };
}

/** The entities one row of a typed table names, with the column and value each came from and, for a ref copied through a foreign key, the table it was copied from. Pure. */
function rowEntities(map: ColumnMap, row: Row, c: MineContext): { entity: string; column: string | null; value: unknown; inheritedFrom?: string }[] {
  const out: { entity: string; column: string | null; value: unknown; inheritedFrom?: string }[] = [];
  for (const m of map.maps) {
    const value = row[m.column];
    const values = Array.isArray(value) ? value : [value];
    const add = (entity: string | undefined, inheritedFrom?: string) => entity && c.known.has(entity) && out.push({ entity, column: m.column, value, ...(inheritedFrom ? { inheritedFrom } : {}) });
    if (m.by === "refs") for (const e of c.held.get(`${m.refTable}|${String(value)}`) ?? []) add(e, m.refTable);
    else
      for (const v of values) {
        if (v === null || v === undefined || v === "") continue;
        if (m.by === "entity") add(ENTITY_ID_SHAPE.test(String(v)) ? String(v) : undefined);
        else if (m.by === "mode") add(c.onto.modeEntity(normaliseMode(v) ?? String(v)));
      }
  }
  return out;
}

/** (b) The refs of a typed table's rows. Pure. */
function columnRefs(map: ColumnMap, rows: readonly Row[], c: MineContext): RefRow[] {
  const refs: RefRow[] = [];
  for (const row of rows) {
    const pk = String(row[map.pk]);
    for (const e of rowEntities(map, row, c)) refs.push(refRow(map.table, UUID_SHAPE.test(pk) ? pk : uuidOf(pk), e.entity, { table: map.table, pk, column: e.column, value: e.value ?? null, ...(e.inheritedFrom ? { [INHERIT_KEY[e.inheritedFrom] ?? "inherited_from"]: e.value ?? null } : {}) }, c.onto));
  }
  return refs;
}

/** Write the refs the table does not hold (`held`: its keys, or null to let the key ignore a duplicate); the count is rows added, or offered when held is null. */
async function writeRefs(sb: Db, refs: readonly RefRow[], held: ReadonlySet<string> | null, notes: string[]): Promise<number> {
  const seen = new Set<string>();
  const fresh = refs.filter((r) => !held?.has(refKey(r)) && !seen.has(refKey(r)) && seen.add(refKey(r)));
  let written = 0;
  for (let i = 0; i < fresh.length; i += 500) {
    // the full pass knows what the table holds and inserts the rest; the tag pass, which does not read the table, offers its rows and the key ignores the ones held
    const { error } = held ? await sb.from("entity_refs").insert(fresh.slice(i, i + 500)) : await sb.from("entity_refs").upsert(fresh.slice(i, i + 500), { onConflict: "ref_table,ref_id,entity_id,role", ignoreDuplicates: true });
    if (error) notes.push(`entity_refs write failed: ${error.message}`);
    else written += Math.min(500, fresh.length - i);
  }
  return written;
}

/** What the mining would write over the database as it stands: every ref planned (new and already held), the keys held, and the counts. Reads only. */
export async function planRefs(sb: Db): Promise<{ plan: RefRow[]; heldKeys: Set<string>; counts: Record<string, number> }> {
  const [entities, identifiers, existing, relations, claims] = await Promise.all([
    readAll<{ entity_id: string; kind: string; canonical_name: string }>(sb, "entities", "entity_id,kind,canonical_name", ["entity_id"]),
    readAll<{ entity_id: string; value: string }>(sb, "entity_identifiers", "entity_id,value", ["entity_id", "scheme", "value"], (q) => q.eq("scheme", "UNLOCODE")),
    readAll<{ ref_table: string; ref_id: string; entity_id: string; role: string; asserted_by: string; basis: { how?: string; span?: unknown; column?: unknown; value?: unknown } | null }>(sb, "entity_refs", "ref_table,ref_id,entity_id,role,asserted_by,basis", ["ref_table", "ref_id", "entity_id", "role"]),
    readAll<{ parent_entity_id: string; child_entity_id: string }>(sb, "entity_relations", "parent_entity_id,child_entity_id", ["parent_entity_id", "child_entity_id", "relation"]),
    readAll<{ id: string; claim_text: string; claim_kind: string; intelligence_item_id: string | null }>(sb, "section_claim_provenance", "id,claim_text,claim_kind,intelligence_item_id", ["id"]),
  ]);
  // every ref already held is kept: this pass adds and never retires (a ref is not "prose" because its entity is not in a file)
  const held = new Map<string, string[]>();
  for (const r of existing) held.set(`${r.ref_table}|${r.ref_id}`, [...(held.get(`${r.ref_table}|${r.ref_id}`) ?? []), r.entity_id]);
  const onto = ontologyOf({ entities, refs: existing, relations });
  const resolver = buildResolver(identifiers.map((i) => ({ entity_id: i.entity_id, code: i.value })), entities.filter((e) => e.kind === "instrument"));
  const ctx: MineContext = { resolver, known: new Set(entities.map((e) => e.entity_id)), held, kinds: new Map(entities.map((e) => [e.entity_id, e.kind])), onto };
  const heldKeys = new Set(existing.map(refKey));
  const plan: RefRow[] = [];
  const take = (refs: RefRow[]) => {
    for (const r of refs) held.set(`${r.ref_table}|${r.ref_id}`, [...new Set([...(held.get(`${r.ref_table}|${r.ref_id}`) ?? []), r.entity_id])]);
    plan.push(...refs);
  };

  const fromClaims = claimRefs(claims, ctx);
  take(fromClaims.refs);
  take(fromClaims.itemRefs);
  const counts: Record<string, number> = { claims: claims.length, claims_resolved: fromClaims.resolved, refs_claims_planned: fromClaims.refs.length, refs_items_from_claims_planned: fromClaims.itemRefs.length, resolver_codes: resolver.codes.size, resolver_instruments: resolver.instruments.size, refs_held: existing.length };
  for (const r of fromClaims.refs) counts[`claim_refs_${ctx.kinds.get(r.entity_id) ?? "entity"}`] = (counts[`claim_refs_${ctx.kinds.get(r.entity_id) ?? "entity"}`] ?? 0) + 1;
  for (const [kind, n] of Object.entries(fromClaims.unresolved)) counts[`claims_unresolved_${kind.toLowerCase()}`] = n;
  for (const map of [ITEM_MAP, ...COLUMNS]) {
    const columns = [map.pk, ...map.maps.map((m) => m.column)];
    const rows = await readAll(sb, map.table, [...new Set(columns)].join(","), [map.pk]);
    const refs = columnRefs(map, rows, ctx);
    counts[`refs_${map.table}_planned`] = refs.length;
    counts[`refs_${map.table}_inherited`] = refs.filter((r) => Object.keys(r.basis).some((k) => k.startsWith("inherited_from"))).length;
    take(refs);
  }
  const fresh = new Set(plan.filter((r) => !heldKeys.has(refKey(r))).map(refKey));
  counts.refs_new = fresh.size;
  counts.refs_kept = existing.length;
  counts.refs_retired = 0;
  counts.entity_classes_reached = new Set(plan.map((r) => onto.classOf(r.entity_id))).size;
  return { plan, heldKeys, counts };
}

export async function mineRefs(deps: { sb: Db; now: () => Date }, input: { dry: boolean }): Promise<RunResult<{ ids: Record<string, string[]> }>> {
  const { sb } = deps;
  const notes: string[] = [];
  const { plan, heldKeys, counts } = await planRefs(sb);
  if (input.dry) return { counts, outcome: "ok", notes: [...notes, "dry: nothing written"], data: { ids: {} } };
  counts.refs_written = await writeRefs(sb, plan, heldKeys, notes);
  return { counts, outcome: notes.length ? "partial" : "ok", notes, data: { ids: {} } };
}
