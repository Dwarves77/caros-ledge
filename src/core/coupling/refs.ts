// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): entity-ref mining over the full corpus (C2). Three inputs write entity_refs, never without a basis and the version of the rule that read it:
// (a) CLAIMS: every section_claim_provenance row's text resolved to entities (resolveText), role from the coupling class, basis {claim_id, span, claim_kind, how};
// (b) TYPED COLUMNS: the column-to-entity mapping of couplings.json over the typed tables (an entity id held in a column, a name resolved through the aliases, a transport mode, a coded value, a constant, or the refs another table's row already holds), basis {table, pk, column, value};
// (c) SCENARIO TAGS: an item's operational scenario tags resolved to the couplings that list them, basis {tag}.
// A table keyed by text (obligation_objects) is keyed in entity_refs by the uuid of its key (uuidOf), the key itself in the basis. Idempotent: a second run writes no ref; a dry run counts the refs it would write.
import { createHash } from "node:crypto";

import { normaliseMode } from "@/core/contracts/vocabularies";
import type { Db } from "@/core/db";
import type { RunResult } from "@/core/types/run-result";

import { COLUMNS, couplingByKey, couplingById, couplingsForScenario, roleOf, type ColumnMap } from "./coupling";
import { readAll, type Row } from "./read";
import { buildResolver, resolveText, type Resolver } from "./resolve";

const REFS_VERSION = "refs@1.0.0";
const REFS_ASSERTED_BY = "coupling/refs";
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_ID_SHAPE = /^cl:[a-z_]+:[0-9a-f]{16}$/;

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
const refRow = (table: string, id: string, entity: string, basis: Record<string, unknown>): RefRow => ({ ref_table: table, ref_id: id, entity_id: entity, role: roleOf(entity), asserted_by: REFS_ASSERTED_BY, basis, method_version: REFS_VERSION });

export interface MineContext {
  resolver: Resolver;
  /** The entities that exist: a ref to any other is refused by the foreign key, so none is planned. */
  known: ReadonlySet<string>;
  /** The refs held so far, `${ref_table}|${ref_id}` to entity ids: what a `refs` mapping copies. */
  held: Map<string, string[]>;
}

/** (a) The refs of a list of claims, and the claims that resolved to nothing by kind. Pure. */
function claimRefs(claims: readonly { id: string; claim_text: string; claim_kind: string }[], c: MineContext): { refs: RefRow[]; resolved: number; unresolved: Record<string, number> } {
  const refs: RefRow[] = [];
  const unresolved: Record<string, number> = {};
  let resolved = 0;
  for (const cl of claims) {
    const hits = resolveText(cl.claim_text, c.resolver).filter((m) => c.known.has(m.entityId));
    if (!hits.length) unresolved[cl.claim_kind] = (unresolved[cl.claim_kind] ?? 0) + 1;
    else resolved += 1;
    for (const m of hits) refs.push(refRow("section_claim_provenance", cl.id, m.entityId, { claim_id: cl.id, span: m.span, claim_kind: cl.claim_kind, how: m.how }));
  }
  return { refs, resolved, unresolved };
}

/** The entities one row of a typed table names, with the column and value each came from. Pure. */
function rowEntities(map: ColumnMap, row: Row, c: MineContext): { entity: string; column: string | null; value: unknown }[] {
  const out: { entity: string; column: string | null; value: unknown }[] = [];
  for (const m of map.maps) {
    const value = m.column ? row[m.column] : null;
    const values = Array.isArray(value) ? value : [value];
    const add = (entity: string | undefined) => entity && c.known.has(entity) && out.push({ entity, column: m.column ?? null, value });
    if (m.by === "const") add(couplingByKey(m.entity ?? "")?.entityId);
    else if (m.by === "refs") for (const e of c.held.get(`${m.refTable}|${String(value)}`) ?? []) add(e);
    else
      for (const v of values) {
        if (v === null || v === undefined || v === "") continue;
        if (m.by === "entity") add(ENTITY_ID_SHAPE.test(String(v)) ? String(v) : undefined);
        else if (m.by === "alias") for (const hit of resolveText(String(v), c.resolver)) add(hit.entityId);
        else if (m.by === "mode") add(couplingByKey(`mode:${normaliseMode(v)}`)?.entityId);
        else if (m.by === "map") add(couplingByKey(m.map?.[String(v)] ?? "")?.entityId);
      }
  }
  return out;
}

/** (b) The refs of a typed table's rows. Pure. */
function columnRefs(map: ColumnMap, rows: readonly Row[], c: MineContext): RefRow[] {
  const refs: RefRow[] = [];
  for (const row of rows) {
    const pk = String(row[map.pk]);
    for (const e of rowEntities(map, row, c)) refs.push(refRow(map.table, UUID_SHAPE.test(pk) ? pk : uuidOf(pk), e.entity, { table: map.table, pk, column: e.column, value: e.value ?? null }));
  }
  return refs;
}

/** (c) The refs of an item's scenario tags: every coupling whose scenario list names a tag. Pure. */
export function tagRefs(itemId: string, tags: readonly string[], known: ReadonlySet<string>): RefRow[] {
  return tags.flatMap((tag) => couplingsForScenario(tag).filter((c) => known.has(c.entityId)).map((c) => refRow("intelligence_items", itemId, c.entityId, { tag })));
}

/** Write the refs the table does not hold (`held`: its keys, or null to let the key ignore a duplicate); the count is rows added, or offered when held is null. */
export async function writeRefs(sb: Db, refs: readonly RefRow[], held: ReadonlySet<string> | null, notes: string[]): Promise<number> {
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

export async function mineRefs(deps: { sb: Db; now: () => Date }, input: { dry: boolean }): Promise<RunResult<{ ids: Record<string, string[]> }>> {
  const { sb } = deps;
  const notes: string[] = [];
  const [entities, aliases, existing] = await Promise.all([
    readAll<{ entity_id: string; kind: string; canonical_name: string }>(sb, "entities", "entity_id,kind,canonical_name", ["entity_id"]),
    readAll<{ entity_id: string; alias: string }>(sb, "entity_aliases", "entity_id,alias", ["entity_id", "alias", "alias_kind", "asserted_by"]),
    readAll<{ ref_table: string; ref_id: string; entity_id: string; role: string }>(sb, "entity_refs", "ref_table,ref_id,entity_id,role", ["ref_table", "ref_id", "entity_id", "role"]),
  ]);
  const held = new Map<string, string[]>();
  for (const r of existing) held.set(`${r.ref_table}|${r.ref_id}`, [...(held.get(`${r.ref_table}|${r.ref_id}`) ?? []), r.entity_id]);
  const ctx: MineContext = { resolver: buildResolver(aliases, entities.filter((e) => e.kind === "instrument")), known: new Set(entities.map((e) => e.entity_id)), held };
  const heldKeys = new Set(existing.map(refKey));
  const plan: RefRow[] = [];
  const take = (refs: RefRow[]) => {
    for (const r of refs) held.set(`${r.ref_table}|${r.ref_id}`, [...new Set([...(held.get(`${r.ref_table}|${r.ref_id}`) ?? []), r.entity_id])]);
    plan.push(...refs);
  };

  const claims = await readAll<{ id: string; claim_text: string; claim_kind: string }>(sb, "section_claim_provenance", "id,claim_text,claim_kind", ["id"]);
  const fromClaims = claimRefs(claims, ctx);
  take(fromClaims.refs);
  const counts: Record<string, number> = { claims: claims.length, claims_resolved: fromClaims.resolved, refs_claims_planned: fromClaims.refs.length };
  for (const [kind, n] of Object.entries(fromClaims.unresolved)) counts[`claims_unresolved_${kind.toLowerCase()}`] = n;
  for (const map of COLUMNS) {
    const columns = [map.pk, ...map.maps.flatMap((m) => (m.column ? [m.column] : []))];
    const rows = await readAll(sb, map.table, [...new Set(columns)].join(","), [map.pk]);
    const refs = columnRefs(map, rows, ctx);
    counts[`refs_${map.table}_planned`] = refs.length;
    take(refs);
  }
  const fresh = new Set(plan.filter((r) => !heldKeys.has(refKey(r))).map(refKey));
  counts.refs_new = fresh.size;
  const classes = new Set(plan.map((r) => couplingById(r.entity_id)?.class ?? "spine"));
  counts.entity_classes_reached = classes.size;
  if (input.dry) return { counts, outcome: "ok", notes: [...notes, "dry: nothing written"], data: { ids: {} } };
  counts.refs_written = await writeRefs(sb, plan, heldKeys, notes);
  return { counts, outcome: notes.length ? "partial" : "ok", notes, data: { ids: {} } };
}
