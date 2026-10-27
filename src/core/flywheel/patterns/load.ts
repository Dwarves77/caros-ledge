// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the reads of the connect stage's pattern step. Joins what the spine holds into the input the five detectors read: the entity refs the mining wrote (claims, typed rows, tags), the coupling relations (both directions), and for every table with a
// fact spec the rows that carry a ref, each as a fact filed under its entities. Every read is paged under a total order and throws on error; a table with no rows yields no facts and the detectors run over what is there.
import { loadOntology, RELATIONS, uuidOf, type Relation } from "@/core/coupling";
import { statutoryUnit } from "@/core/parse";
import { readAll, type Row } from "@/core/coupling/read";
import type { Db } from "@/core/db";
import { surfaceOf } from "@/core/routing";

import { FACT_SPECS, PATTERNS, UNIT_FORMS } from "./config";
import { factOf } from "./facts";
import type { Fact, PatternInput } from "./types";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const columnsOf = (table: string): string =>
  [...new Set((FACT_SPECS[table] ?? []).flatMap((s) => [s.pk, s.at, ...[s.due ?? []].flat(), s.dueYear, s.dueMonthsAfterAt, s.qty?.column, s.qty?.unitColumn, s.qty?.figure, s.source, s.tier, s.kind, s.trl, s.group, s.item, s.owner, s.capture, s.resolved, s.from, s.until]).filter((c): c is string => !!c))].join(",");

/** A series' points become their moves: each point's relative change from the previous point of the same series, dated at the point. The first point of a series has no move and is dropped. */
function seriesMoves(facts: readonly Fact[]): Fact[] {
  const out: Fact[] = [];
  const groups = new Map<string, Fact[]>();
  for (const f of facts) groups.set(f.group ?? f.pk, [...(groups.get(f.group ?? f.pk) ?? []), f]);
  for (const list of groups.values()) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.pk.localeCompare(b.pk));
    list.forEach((f, n) => {
      const prev = list[n - 1];
      if (prev && prev.qty && f.qty !== null && prev.unit === f.unit) out.push({ ...f, qty: (f.qty - prev.qty) / Math.abs(prev.qty), unit: "ratio" });
    });
  }
  return out;
}

export async function loadPatternInput(sb: Db, now: Date, opts: { extraRefs?: readonly { ref_table: string; ref_id: string; entity_id: string }[] } = {}): Promise<{ input: PatternInput; counts: Record<string, number> }> {
  const onto = await loadOntology(sb);
  const refs = await readAll<{ ref_table: string; ref_id: string; entity_id: string }>(sb, "entity_refs", "ref_table,ref_id,entity_id", ["ref_table", "ref_id", "entity_id", "role"], (q) => q.not("method_version", "is", null));
  const filed = new Map<string, string[]>();
  // `extraRefs`: refs not yet written (a dry plan of the mining), read as if held; a ref already held is not counted twice
  for (const r of [...refs, ...(opts.extraRefs ?? [])]) if (!(filed.get(`${r.ref_table}|${r.ref_id}`) ?? []).includes(r.entity_id)) filed.set(`${r.ref_table}|${r.ref_id}`, [...(filed.get(`${r.ref_table}|${r.ref_id}`) ?? []), r.entity_id]);
  const links = await readAll<{ parent_entity_id: string; child_entity_id: string; relation: string; method_version: string | null }>(sb, "entity_relations", "parent_entity_id,child_entity_id,relation,method_version", ["parent_entity_id", "child_entity_id", "relation"]);
  const near = new Map<string, { entity: string; relation: Relation }[]>();
  for (const l of links.filter((x) => (RELATIONS as readonly string[]).includes(x.relation))) {
    near.set(l.parent_entity_id, [...(near.get(l.parent_entity_id) ?? []), { entity: l.child_entity_id, relation: l.relation as Relation }]);
    near.set(l.child_entity_id, [...(near.get(l.child_entity_id) ?? []), { entity: l.parent_entity_id, relation: l.relation as Relation }]);
  }
  const items = new Map((await readAll<{ id: string; item_type: string | null; domain: number | null; added_date: string | null }>(sb, "intelligence_items", "id,item_type,domain,added_date", ["id"])).map((i) => [i.id, { surface: surfaceOf(i.item_type, i.domain), added: i.added_date?.slice(0, 10) ?? null }]));
  const readerEdges = links.filter((l) => l.method_version?.startsWith("reader@") && (RELATIONS as readonly string[]).includes(l.relation)).map((l) => ({ parent: l.parent_entity_id, child: l.child_entity_id, relation: l.relation as Relation }));
  // the document date of each capture that states one (DOC-DATE-1: agent_run_searches.document_date, read from formal codes only): a claim is dated by the capture it was read from, never by the day its item was added
  const documentDates = new Map((await readAll<{ id: string; document_date: string }>(sb, "agent_run_searches", "id,document_date", ["id"], (q) => q.not("document_date", "is", null))).map((c) => [c.id, c.document_date.slice(0, 10)]));
  const counts: Record<string, number> = { refs_read: refs.length, relations_read: links.length, relations_reader: readerEdges.length, captures_dated: documentDates.size };
  const facts: Fact[] = [];
  const flow = new Map<string, number>();
  for (const [table, specs] of Object.entries(FACT_SPECS)) {
    if (table === "derived_values") continue;
    const rows = await readAll<Row>(sb, table, columnsOf(table), [specs[0]?.pk ?? "id"]);
    const made = specs.flatMap((spec) =>
      rows.flatMap((r) => {
        const pk = String(r[spec.pk]);
        const item = spec.item ? items.get(String(r[spec.item])) : undefined;
        const es = filed.get(`${table}|${UUID_SHAPE.test(pk) ? pk : uuidOf(pk)}`);
        const f = es ? factOf(spec.edge ?? table, r, es, { surface: item?.surface, ...(item?.added ? { at: item.added } : {}), role: spec.role, now, ontology: onto, ...(spec.capture ? { docAt: documentDates.get(String(r[spec.capture])) ?? null } : {}) }) : null;
        return f ? [f] : [];
      }),
    );
    // the corpus's flow: every claim that is not an absence, filed or not, on the document date of its capture (an undated claim is in neither the flow nor a burst)
    for (const spec of specs.filter((x) => x.role === "claim" && x.capture)) for (const r of rows) {
      const day = documentDates.get(String(r[spec.capture as string]));
      if (day && !PATTERNS.velocity.excludeKinds.includes(String(r[spec.kind ?? ""]))) flow.set(day, (flow.get(day) ?? 0) + 1);
    }
    counts[`facts_${table}`] = made.length;
    facts.push(...(table === "market_series" ? seriesMoves(made) : made));
  }
  // the derived abatement costs: the current derived values in the unit the abatement attribute is measured in, each filed under its own entity
  const unit = PATTERNS.penaltyAbatement.abatementUnit;
  const abatement = unit ? await readAll<Row>(sb, "derived_values", `${columnsOf("derived_values")},entity_id,admissibility,lifecycle`, ["value_id"], (q) => q.not("unit", "is", null)) : [];
  const live = abatement.filter((r) => r.entity_id && statutoryUnit(String(r.unit), UNIT_FORMS) === unit && r.admissibility !== "stale" && !["falsified", "obsolete", "superseded"].includes(String(r.lifecycle)));
  facts.push(...live.flatMap((r) => factOf("derived_values", r, [String(r.entity_id)], { now, ontology: onto }) ?? []));
  counts.facts_derived_values = live.length;
  counts.facts_unit_unknown = facts.filter((f) => f.unitUnknown).length;
  return { input: { now, facts, related: (e) => near.get(e) ?? [], readerEdges, flow, classOf: onto.classOf, modesOf: onto.modesOf }, counts };
}
