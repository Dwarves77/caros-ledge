// New in CONNECT-2 PR B (scripts/ci/new-files/connect-2b.txt): the pattern packets the reader sees (C4, unified design section 2). One packet per live pattern, built from the derived value that records it and the evidence rows its derivation edges name: every member row with its typed columns, the verbatim spans it carries
// (a claim's text and source span, an obligation's verbatim text, an event's span, each with the capture and source it was read from, located in the capture by locateSpan and never by an offset), the intelligence item each row belongs to with that item's provenance_status (a quarantined item's rows are in the packet and say so),
// the entity refs of the rows with their bases, the relations of the pattern's entities (reader-asserted ones flagged), the signposts already open, and context rows (the claims, forward events and obligation objects of the member items, the other points of a member's series in the move window), all under the caps in
// data/packets.json with the cap stated inside the packet, never silently. A brief may cite only what a packet contains (INV-CN2-4): `uncitedIds` is the check the kind's validator runs. A P1 pattern is packet-eligible only when it was computed on dated claims (its method version is the document-date clock's)
// and one of its entities carries a reader-asserted relation. This file is the ONE file the DIGEST-1 PR B kinds import.
import { couplingById } from "@/core/coupling/coupling";
import { readAll } from "@/core/coupling/read";
import { uuidOf } from "@/core/coupling/refs";
import type { Db } from "@/core/db";
import { isUuid } from "@/core/http/parse";
import { allRows, fetchAllByIdChunks, rowsByIds } from "@/core/db";
import { FACT_SPECS, PATTERNS } from "@/core/flywheel/patterns/config";
import { KINDS, patternSeed, type PatternKind } from "@/core/flywheel/patterns/types";
import { PATTERN_METHODS } from "@/core/propagation/methods";
import type { InputRef } from "@/core/propagation/types";

import cfg from "./data/packets.json";

const PACKET_VERSION: string = cfg.version;
export type PacketEdge = "member" | "evidence" | "key" | "context";
/** A verbatim slice a row carries: located in `capture_id` by locateSpan (the text), never by an offset. */
export interface PacketSpan { kind: "claim" | "verbatim" | "event"; text: string; source_span: string | null; capture_id: string | null; source_id: string | null }
export interface PacketMember {
  /** The row: its table and primary key. An item of the packet is a member of the table intelligence_items. */
  table: string;
  id: string;
  /** The coupling class of the first entity the row is filed under that has one. */
  entity_kind?: string | null;
  edge: PacketEdge;
  entities: string[];
  item_id: string | null;
  /** The provenance_status of the item the row belongs to. */
  provenance_status: string | null;
  columns: Record<string, unknown>;
  spans: PacketSpan[];
}
export interface PacketRelation { id: string; parent: string; child: string; relation: string; reader: boolean; basis: Record<string, unknown> | null; method_version: string | null }
export interface PacketRef { ref_table: string; ref_id: string; entity_id: string; role: string; basis: Record<string, unknown> | null; method_version: string | null }
export interface PacketSignpost { entity_id: string; direction: string; outcome: string | null; predicate: Record<string, unknown> }
export interface PacketPattern { value_id: string; method_id: string; method_version: string; kind: PatternKind; key: string; entity: string; value: number; unit: string | null; admissibility: string; lifecycle: string }
export interface PacketCap { max_members: number; members_total: number; members_omitted: number; relations_total: number; relations_omitted: number; context_per_table: number; context_omitted: number }
export interface Packet {
  kind: "pattern" | "theme" | "item";
  /** A pattern packet's id is the derived value's id; a theme packet's is the theme's. */
  id: string;
  version: string;
  pattern: PacketPattern | null;
  /** A theme packet: the ids of the pattern packets it gathers. */
  patterns: string[];
  members: PacketMember[];
  relations: PacketRelation[];
  refs: PacketRef[];
  signposts: PacketSignpost[];
  eligible: { dated: boolean; reader_edge: boolean };
  cap: PacketCap;
  [column: string]: unknown;
}
export interface PacketRead { packets: Packet[]; marker: string | null }

type Row = Record<string, unknown>;
export interface PatternRow { value_id: string; entity_id: string | null; method_id: string; method_version: string; value: number | string; unit: string | null; admissibility: string; lifecycle: string; computed_by: string; inputs: InputRef[] | null }
const KIND_OF = Object.fromEntries(KINDS.map((k) => [PATTERN_METHODS[k].id, k])) as Record<string, PatternKind>;
const COLUMNS = cfg.columns as Record<string, string[]>;
const SPANS = cfg.spans as Record<string, { kind: PacketSpan["kind"]; text: string; span?: string; capture?: string; source?: string }>;
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const specOf = (table: string) => Object.entries(FACT_SPECS).flatMap(([read, specs]) => specs.filter((s) => (s.edge ?? read) === table))[0];
const pkOf = (table: string): string => specOf(table)?.pk ?? cfg.context.find((c) => c.table === table)?.order[0] ?? "id";
const columnsOf = (table: string): string => {
  const sp = SPANS[table];
  return [...new Set([...(COLUMNS[table] ?? []), pkOf(table), specOf(table)?.owner, sp?.text, sp?.span, sp?.capture, sp?.source, ...cfg.context.filter((c) => c.table === table).map((c) => c.by)])].filter((c): c is string => !!c).join(",");
};
/** Every row whose `col` is in the ids, chunked under the URL budget, paged under the total order given. */
const byIds = (sb: Db, table: string, columns: string, col: string, ids: Iterable<string>, order: readonly string[], only: Record<string, string[]> = {}): Promise<Row[]> =>
  fetchAllByIdChunks([...new Set(ids)], (slice) => readAll<Row>(sb, table, columns, order, (q) => Object.entries(only).reduce((x, [c, v]) => x.in(c, v), q.in(col, slice))), { manyPerId: true });

function memberOf(table: string, row: Row, edge: PacketEdge, entities: readonly string[], items: ReadonlyMap<string, string | null>): PacketMember {
  const sp = SPANS[table];
  const owner = specOf(table)?.owner ?? cfg.context.find((c) => c.table === table)?.by;
  const item = owner ? text(row[owner]) : null;
  return {
    table, id: String(row[pkOf(table)]), entity_kind: entities.map((e) => couplingById(e)?.class).find((c): c is string => !!c) ?? null, edge, entities: [...entities], item_id: item, provenance_status: item ? (items.get(item) ?? null) : null,
    columns: Object.fromEntries((COLUMNS[table] ?? []).map((c) => [c, row[c] ?? null])),
    spans: sp && text(row[sp.text]) ? [{ kind: sp.kind, text: row[sp.text] as string, source_span: sp.span ? text(row[sp.span]) : null, capture_id: sp.capture ? text(row[sp.capture]) : null, source_id: sp.source ? text(row[sp.source]) : null }] : [],
  };
}

/** The pattern packets of stored patterns (derived values of the pattern methods), in the order given; `ineligible` counts the P1 patterns held back. */
async function buildPatternPackets(sb: Db, patterns: readonly PatternRow[]): Promise<{ packets: Packet[]; ineligible: number }> {
  const inputs = patterns.map((p) => (p.inputs ?? []).filter((i) => i.table && i.pk));
  const rows = new Map<string, Row>();
  for (const table of [...new Set(inputs.flat().map((i) => i.table))]) for (const r of await rowsByIds<Row>(sb, table, columnsOf(table), inputs.flat().filter((i) => i.table === table).map((i) => i.pk), pkOf(table), pkOf(table))) rows.set(`${table}/${String(r[pkOf(table)])}`, r);
  const ownerOf = (key: string): string | null => {
    const owner = specOf(key.split("/")[0] as string)?.owner;
    return owner ? text((rows.get(key) as Row)[owner]) : null;
  };
  // context: the claims, forward events and obligation objects of the member items, and the other points of a member's series inside the move window
  const itemIds = [...new Set([...rows.keys()].map(ownerOf).filter((x): x is string => !!x))];
  const items = new Map((await rowsByIds<{ id: string; provenance_status: string | null }>(sb, "intelligence_items", "id,provenance_status", itemIds)).map((i) => [i.id, i.provenance_status]));
  const context = new Map<string, Row[]>();
  for (const c of cfg.context) context.set(c.table, await byIds(sb, c.table, columnsOf(c.table), c.by, itemIds, c.order, "only" in c ? (c.only as Record<string, string[]>) : {}));
  const seriesKeys = [...new Set([...rows].filter(([k]) => k.startsWith("market_series/")).map(([, r]) => text(r.series_key)).filter((x): x is string => !!x))];
  const points = seriesKeys.length ? await byIds(sb, "market_series", columnsOf("market_series"), "series_key", seriesKeys, ["id"]) : [];
  const entityIds = [...new Set(patterns.flatMap((p, n) => [p.entity_id ?? "", ...(inputs[n] ?? []).flatMap((i) => i.entities ?? [])]).filter(Boolean))];
  const relRows = [...(await byIds(sb, "entity_relations", "parent_entity_id,child_entity_id,relation,basis,method_version", "parent_entity_id", entityIds, ["parent_entity_id", "child_entity_id", "relation"])), ...(await byIds(sb, "entity_relations", "parent_entity_id,child_entity_id,relation,basis,method_version", "child_entity_id", entityIds, ["parent_entity_id", "child_entity_id", "relation"]))];
  const relationOf = (r: Row): PacketRelation => ({ id: `${String(r.parent_entity_id)}|${String(r.relation)}|${String(r.child_entity_id)}`, parent: String(r.parent_entity_id), child: String(r.child_entity_id), relation: String(r.relation), reader: String(r.method_version ?? "").startsWith("reader@"), basis: (r.basis as Record<string, unknown> | null) ?? null, method_version: text(r.method_version) });
  const pks = [...rows.keys()].map((k) => k.split("/")[1] as string);
  const refRows = await byIds(sb, "entity_refs", "ref_table,ref_id,entity_id,role,basis,method_version", "ref_id", [...pks.filter(isUuid), ...pks.map(uuidOf)], ["ref_table", "ref_id", "entity_id", "role"]);
  const seeds = patterns.map((p) => `pattern-signpost:${patternSeed({ kind: KIND_OF[p.method_id] as PatternKind, key: p.computed_by.slice(p.computed_by.indexOf(":") + 1) })}`);
  const records = await byIds(sb, "inference_records", "inference_id,computed_by", "computed_by", seeds, ["inference_id"]);
  const posts = await byIds(sb, "signposts", "entity_id,direction,outcome,predicate,inference_record_id", "inference_record_id", records.map((r) => String(r.inference_id)), ["entity_id"]);
  const packets: Packet[] = [];
  let ineligible = 0;
  patterns.forEach((p, n) => {
    const kind = KIND_OF[p.method_id] as PatternKind;
    const ins = inputs[n] ?? [];
    const own = new Set([p.entity_id ?? "", ...ins.flatMap((i) => i.entities ?? [])]);
    const rels = new Map(relRows.map(relationOf).filter((r) => own.has(r.parent) || own.has(r.child)).map((r) => [r.id, r]));
    const relations = [...rels.values()].sort((a, b) => a.id.localeCompare(b.id));
    const eligible = { dated: kind !== "velocity" || p.method_version === PATTERN_METHODS.velocity.version, reader_edge: relations.some((r) => r.reader) };
    if (kind === "velocity" && !(eligible.dated && eligible.reader_edge)) {
      ineligible += 1;
      return;
    }
    const evidence = ins.flatMap((i) => (rows.has(`${i.table}/${i.pk}`) ? [memberOf(i.table, rows.get(`${i.table}/${i.pk}`) as Row, (i.kind as PacketEdge) ?? "member", i.entities ?? [], items)] : []));
    const mine = new Set(evidence.map((m) => `${m.table}/${m.id}`));
    const mineItems = new Set(evidence.map((m) => m.item_id).filter((x): x is string => !!x));
    const first = Math.min(...evidence.filter((m) => m.table === "market_series").map((m) => Date.parse(String(m.columns.as_at_date))));
    const window = Number.isFinite(first) ? new Date(first - PATTERNS.leadLag.moveWindowDays * 86_400_000).toISOString().slice(0, 10) : "9";
    const ctxAll = [
      ...cfg.context.flatMap((c) => (context.get(c.table) ?? []).filter((r) => mineItems.has(text(r[c.by]) ?? "") && !mine.has(`${c.table}/${String(r[pkOf(c.table)])}`)).slice(0, cfg.maxContextPerTable).map((r) => memberOf(c.table, r, "context", [], items))),
      ...points.filter((r) => evidence.some((m) => m.table === "market_series" && m.columns.series_key === r.series_key) && String(r.as_at_date) >= window && !mine.has(`market_series/${String(r.id)}`)).slice(0, cfg.maxContextPerTable).map((r) => memberOf("market_series", r, "context", [], items)),
    ];
    const members = evidence.slice(0, cfg.maxMembers);
    const itemMembers = [...mineItems].sort().map((id): PacketMember => ({ table: "intelligence_items", id, edge: "context", entities: [], item_id: id, provenance_status: items.get(id) ?? null, columns: { provenance_status: items.get(id) ?? null }, spans: [] }));
    const total = cfg.context.reduce((t, c) => t + (context.get(c.table) ?? []).filter((r) => mineItems.has(text(r[c.by]) ?? "") && !mine.has(`${c.table}/${String(r[pkOf(c.table)])}`)).length, 0);
    packets.push({
      kind: "pattern", id: p.value_id, version: PACKET_VERSION, patterns: [], eligible,
      pattern: { value_id: p.value_id, method_id: p.method_id, method_version: p.method_version, kind, key: p.computed_by.slice(p.computed_by.indexOf(":") + 1), entity: p.entity_id ?? "", value: Number(p.value), unit: p.unit, admissibility: p.admissibility, lifecycle: p.lifecycle },
      members: [...members, ...ctxAll, ...itemMembers], relations: relations.slice(0, cfg.maxRelations),
      refs: refRows.filter((r) => evidence.some((m) => r.ref_id === m.id || r.ref_id === uuidOf(m.id))).map((r) => ({ ref_table: String(r.ref_table), ref_id: String(r.ref_id), entity_id: String(r.entity_id), role: String(r.role), basis: (r.basis as Record<string, unknown> | null) ?? null, method_version: text(r.method_version) })),
      signposts: posts.filter((s) => records.some((r) => r.inference_id === s.inference_record_id && r.computed_by === seeds[n])).map((s) => ({ entity_id: String(s.entity_id), direction: String(s.direction), outcome: text(s.outcome), predicate: s.predicate as Record<string, unknown> })),
      cap: { max_members: cfg.maxMembers, members_total: evidence.length, members_omitted: evidence.length - members.length, relations_total: relations.length, relations_omitted: Math.max(0, relations.length - cfg.maxRelations), context_per_table: cfg.maxContextPerTable, context_omitted: Math.max(0, total - ctxAll.length) },
    });
  });
  return { packets, ineligible };
}

/** The packets for the ids a kind exports: a pattern's value id, an item id (the packets whose members include the item) or a theme id (a theme packet gathering the patterns that touch one of its items). The marker states what is absent and why; it is null when every id was served. */
export async function readPackets(sb: Db, ids: readonly string[]): Promise<PacketRead> {
  if (!ids.length) return { packets: [], marker: null };
  const live = await allRows<PatternRow>(sb, "derived_values", "value_id,entity_id,method_id,method_version,value,unit,admissibility,lifecycle,computed_by,inputs", { order: "value_id", where: (q) => q.in("method_id", Object.keys(KIND_OF)).neq("admissibility", "stale") });
  const { packets, ineligible } = await buildPatternPackets(sb, live.filter((r) => !["falsified", "obsolete", "superseded"].includes(r.lifecycle)));
  const itemsOf = (p: Packet): string[] => p.members.filter((m) => m.table === "intelligence_items").map((m) => m.id);
  const out: Packet[] = packets.filter((p) => ids.includes(p.id) || itemsOf(p).some((i) => ids.includes(i)));
  const served = new Set(out.flatMap((p) => [p.id, ...itemsOf(p)]));
  for (const t of await rowsByIds<{ id: string; member_ids: string[] }>(sb, "connection_themes", "id,member_ids", ids)) {
    const mine = packets.filter((p) => itemsOf(p).some((i) => (t.member_ids ?? []).includes(i)));
    served.add(t.id);
    out.push({ kind: "theme", id: t.id, version: PACKET_VERSION, pattern: null, patterns: mine.map((p) => p.id), members: mine.flatMap((p) => p.members), relations: mine.flatMap((p) => p.relations), refs: mine.flatMap((p) => p.refs), signposts: mine.flatMap((p) => p.signposts), eligible: { dated: true, reader_edge: mine.every((p) => p.eligible.reader_edge) }, cap: { max_members: cfg.maxMembers, members_total: mine.reduce((n, p) => n + p.cap.members_total, 0), members_omitted: mine.reduce((n, p) => n + p.cap.members_omitted, 0), relations_total: 0, relations_omitted: 0, context_per_table: cfg.maxContextPerTable, context_omitted: mine.reduce((n, p) => n + p.cap.context_omitted, 0) } });
  }
  const missing = ids.filter((i) => !served.has(i));
  return { packets: out, marker: missing.length || ineligible ? `packets: ${missing.length} of ${ids.length} ids have no live pattern packet${ineligible ? `; ${ineligible} P1 pattern(s) held back (undated or no reader-asserted edge)` : ""}` : null };
}

/** The ids a brief may cite from a packet (INV-CN2-4): the packet, its pattern, its member rows (items included), its relations and its signposts. */
export const citableIds = (p: Packet): Set<string> => new Set([p.id, ...(p.pattern ? [p.pattern.value_id] : []), ...p.patterns, ...p.members.map((m) => m.id), ...p.relations.map((r) => r.id), ...p.signposts.map((s) => s.entity_id)]);
/** The cited ids a packet does not contain: the kind's validator refuses an entry that cites any. */
export const uncitedIds = (p: Packet, cited: readonly string[]): string[] => cited.filter((c) => !citableIds(p).has(c));
