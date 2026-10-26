// New in DIGEST-1 PR B (scripts/ci/new-files/digest-1b.txt), UNIFIED-PRB-DESIGN section 1: the live material the emission validator checks against (loadEmit) and the writes an entry's typed blocks make (writeEmission). Every write carries method_version reader@<kinds version> and the
// quote it rests on. Entities are filed by entity_refs (the typed key the detectors join on); obligation_fields go through the derive's own buildObjectRow path as extra candidates, so a reader value supersedes a derived one per column and a derived value never overwrites it;
// connections are entity_relations with a basis; events are capture-backed item_forward_events; a document date fills a capture the producer could not date; new entities are proposed as vocabulary terms (never minted inline; adoption is the recurrence rule's).
import { createHash } from "node:crypto";

import { COUPLINGS, roleOf, uuidOf } from "@/core/coupling";
import { readAll } from "@/core/coupling/read";
import { allRows, fetchAllByIdChunks, rowsByIds, type Db } from "@/core/db";
import { READER_METHOD } from "@/core/digest/kinds";
import { VALIDATORS } from "@/core/entities/crosswalk";
import { readPool } from "@/core/grounding";
import { normaliseTermKey } from "@/core/vocabulary/adopted";
import { currentObligationObjects } from "@/core/workspace";
import { deriveObligationObjects, forwardEventKey, insertForwardEvents, type Candidate, type ExtractedEvent } from "@/features/obligations";

import type { BatchDeps, Obj } from "../../kit/session-batch";

import { candidateMenu, itemSeed } from "./candidates";
import type { EmissionPlan, EmitLive } from "./emission";

const FORMAL = /^(CELEX|UNLOCODE|ISO3166_1|ISO3166_2):(.+)$/;
const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
type Row = Record<string, unknown>;

/** The formal codes and closed tokens an entry writes where an entity id goes: the strings that are not cl: ids. */
export function entityTokens(e: Obj): string[] {
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const raw = [...arr(e.entity_ids).map((x) => (x as Obj | null)?.entity_id), ...arr(e.obligation_fields).flatMap((o) => arr((o as Obj | null)?.entity_ids)), ...arr(e.events).flatMap((v) => arr((v as Obj | null)?.entity_ids)), ...arr(e.connections).flatMap((c) => [(c as Obj | null)?.from_entity_id, (c as Obj | null)?.to_entity_id])];
  return raw.filter((x): x is string => typeof x === "string" && !x.startsWith("cl:"));
}

/** The item's live material for the validator: its captures, the ids a reader may write (the menu, closed mode and hub tokens, formal codes the crosswalk resolves to an active entity), and its current obligation objects. */
export async function loadEmit(deps: BatchDeps, itemId: string, tokens: readonly string[]): Promise<EmitLive> {
  const sb = deps.sb;
  const [it] = await rowsByIds<{ id: string; instrument_entity_id: string | null; jurisdiction_iso: string[] | null; source_url: string | null }>(sb, "intelligence_items", "id, instrument_entity_id, jurisdiction_iso, source_url", [itemId]);
  const captures = new Map((await readPool(sb, itemId)).map((p) => [p.id, p.text]));
  const [claims, events, objects] = [await allRows<{ id: string }>(sb, "section_claim_provenance", "id", { where: (q) => q.eq("intelligence_item_id", itemId) }), await allRows<{ id: string }>(sb, "item_forward_events", "id", { where: (q) => q.eq("intelligence_item_id", itemId) }), await readObjects(sb, itemId)];
  const menu = it ? await candidateMenu(sb, await itemSeed(sb, it, { claimIds: claims.map((c) => c.id), eventIds: events.map((e) => e.id), obligationIds: objects.map((o) => String(o.obligation_id)) })) : { ids: [] as string[] };
  const ids = new Map<string, string>([...menu.ids.map((id) => [id, id] as const), ...COUPLINGS.filter((c) => c.class === "mode" || c.class === "hub").map((c) => [c.key, c.entityId] as const)]);
  for (const t of new Set(tokens)) {
    const m = FORMAL.exec(t);
    if (!m || !VALIDATORS[m[1] as keyof typeof VALIDATORS](m[2])) continue;
    const hit = await readAll<{ entity_id: string }>(sb, "entity_identifiers", "entity_id", ["entity_id"], (q) => q.eq("scheme", m[1]).eq("value", m[2]));
    const ents = await rowsByIds<{ entity_id: string; status: string; merged_into: string | null }>(sb, "entities", "entity_id, status, merged_into", hit.map((h) => h.entity_id), "entity_id", "entity_id");
    const live = [...new Set(ents.flatMap((e) => (e.status === "active" ? [e.entity_id] : e.merged_into ? [e.merged_into] : [])))];
    if (live.length === 1) ids.set(t, live[0] as string);
  }
  return { captures, ids, objects: new Map(currentObligationObjects<Row & { obligation_id: string; pinpoint_citation: string }>(objects as never).map((o) => [o.obligation_id, o.pinpoint_citation])), locate: deps.locate ?? null };
}
const readObjects = (sb: Db, itemId: string): Promise<Row[]> => allRows<Row>(sb, "obligation_objects", "*", { order: "obligation_id", where: (q) => q.eq("instrument_item_id", itemId) });

const NOT_CARRIED = new Set(["obligation_id", "version", "supersedes", "instrument_entity_id", "status", "created_at", "updated_at", "capture_id", "instrument_item_id", "pinpoint_citation", "verbatim_text", "method_version", "basis"]);
const ref = (table: string, id: string, entity: string, basis: Row): Row => ({ ref_table: table, ref_id: id, entity_id: entity, role: roleOf(entity), asserted_by: "reader", basis, method_version: READER_METHOD });
/** File refs: a ref the reader already holds under this version is left; one that exists from the mining is replaced by the reader's (its basis is the quote). Returns rows written. */
async function fileRefs(sb: Db, rows: readonly Row[], notes: string[]): Promise<number> {
  const held = await fetchAllByIdChunks<Row>(rows.map((r) => String(r.ref_id)), (slice) => readAll<Row>(sb, "entity_refs", "ref_table, ref_id, entity_id, role, asserted_by, method_version", ["ref_table", "ref_id", "entity_id", "role"], (q) => q.in("ref_id", slice)), { manyPerId: true });
  const key = (r: Row) => `${r.ref_table}|${r.ref_id}|${r.entity_id}|${r.role}`;
  const done = new Set(held.filter((h) => h.asserted_by === "reader" && h.method_version === READER_METHOD).map(key));
  const fresh = [...new Map(rows.filter((r) => !done.has(key(r))).map((r) => [key(r), r])).values()];
  if (!fresh.length) return 0;
  const { error } = await sb.from("entity_refs").upsert(fresh, { onConflict: "ref_table,ref_id,entity_id,role" });
  return error ? (notes.push(`entity_refs write failed: ${error.message}`), 0) : fresh.length;
}

/** The writes of one entry's plan. Counts and notes only; a refusal of one value never stops the others (it is a note and a count, and the entry's step reports failed). */
export async function writeEmission(deps: BatchDeps, itemId: string, sourceId: string | null, plan: EmissionPlan, captureIds: ReadonlySet<string>): Promise<{ counts: Record<string, number>; notes: string[] }> {
  const { sb } = deps;
  const [counts, notes]: [Record<string, number>, string[]] = [{}, []];
  const bump = (k: string, n = 1) => void (counts[k] = (counts[k] ?? 0) + n);
  const refs: Row[] = plan.entities.map((e) => ref("intelligence_items", itemId, e.entity_id, { quote: e.quote.text, capture_id: e.quote.capture_id }));
  // obligation_fields: candidates through the derive's buildObjectRow; the prior object's columns are carried under the reader's values (a carried figure the new provision no longer states is dropped)
  if (plan.objects.length) {
    const prior = new Map(currentObligationObjects<Row & { obligation_id: string; pinpoint_citation: string }>((await readObjects(sb, itemId)) as never).map((o) => [norm(o.pinpoint_citation), o]));
    const candidates: Candidate[] = plan.objects.map((o) => {
      const carried = Object.fromEntries(Object.entries(prior.get(norm(o.pinpoint)) ?? {}).filter(([k]) => !NOT_CARRIED.has(k)));
      for (const col of ["statutory_maximum", "cost_formula"] as const) if (typeof carried[col] === "string" && !(o.set[col] !== undefined) && !norm(o.provision.text).includes(norm(carried[col] as string))) carried[col] = null;
      const hash = createHash("sha256").update(JSON.stringify({ set: o.set, quotes: o.quotes, provision: o.provision })).digest("hex");
      return { ...carried, ...o.set, instrument_item_id: itemId, capture_id: o.provision.capture_id, pinpoint_citation: o.pinpoint, verbatim_text: o.provision.text, method_version: READER_METHOD, basis: { reader: READER_METHOD, fields_hash: hash, provision: o.provision, quotes: o.quotes } } as unknown as Candidate;
    });
    const r = await deriveObligationObjects(sb, { dry: false, itemIds: [itemId], extraCandidates: candidates });
    const mine = new Set(plan.objects.map((o) => norm(o.pinpoint)));
    for (const x of r.data?.plan.refused ?? []) if (mine.has(norm(x.pinpoint_citation ?? ""))) {
      bump("objects_refused");
      notes.push(`obligation_fields ${x.pinpoint_citation}: refused (${x.reason})`);
    }
    bump("objects_written", (r.data?.plan.toInsert ?? []).filter((p) => p.row.method_version === READER_METHOD).length);
    const current = new Map(currentObligationObjects<Row & { pinpoint_citation: string; obligation_id: string }>((await readObjects(sb, itemId)) as never).map((o) => [norm(o.pinpoint_citation), o.obligation_id]));
    for (const o of plan.objects) for (const e of o.entity_ids) if (current.has(norm(o.pinpoint))) refs.push(ref("obligation_objects", uuidOf(current.get(norm(o.pinpoint)) as string), e, { quote: o.provision.text, capture_id: o.provision.capture_id, pinpoint: o.pinpoint }));
  }
  // connections: an edge the table already holds (a seed or another brief's) stands; a refusal (the cycle trigger) is counted
  for (const c of plan.connections) {
    const held = await readAll<Row>(sb, "entity_relations", "parent_entity_id", ["parent_entity_id", "child_entity_id", "relation"], (q) => q.eq("parent_entity_id", c.parent).eq("child_entity_id", c.child).eq("relation", c.relation));
    if (held.length) continue;
    const { error } = await sb.from("entity_relations").insert({ parent_entity_id: c.parent, child_entity_id: c.child, relation: c.relation, asserted_by: "reader", basis: { quote: c.quote.text, capture_id: c.quote.capture_id, reader: READER_METHOD, reason_token: c.reason_token }, method_version: READER_METHOD });
    if (error) notes.push(`connection ${c.parent} ${c.relation} ${c.child}: refused (${error.message})`);
    bump(error ? "connections_refused" : "connections_written");
  }
  // events: capture-backed, medium confidence (a high one needs a claim); the entities and the mode token are filed on the stored row
  if (plan.events.length) {
    const rows: ExtractedEvent[] = plan.events.map((e) => ({ event_date: e.event_date, date_precision: e.date_precision, event_kind: e.event_kind as ExtractedEvent["event_kind"], obligation_text: e.quote.text, source_kind: "capture", source_claim_id: null, source_section_id: null, source_capture_id: e.quote.capture_id, source_span: e.quote.text, confidence: "medium", extractor_version: READER_METHOD }));
    bump("events_written", (await insertForwardEvents(sb, itemId, rows, { claimIds: new Set(), sectionIds: new Set(), captureIds })).inserted);
    const stored = new Map((await allRows<Row & { id: string; event_date: string; event_kind: string; obligation_text: string }>(sb, "item_forward_events", "id, event_date, event_kind, obligation_text", { where: (q) => q.eq("intelligence_item_id", itemId) })).map((s) => [forwardEventKey(s), s.id]));
    for (const e of plan.events) {
      const id = stored.get(forwardEventKey({ event_date: e.event_date, event_kind: e.event_kind, obligation_text: e.quote.text }));
      const mode = e.mode ? COUPLINGS.find((c) => c.key === `mode:${e.mode}`)?.entityId : undefined;
      for (const ent of [...e.entity_ids, ...(mode ? [mode] : [])]) if (id) refs.push(ref("item_forward_events", id, ent, { quote: e.quote.text, capture_id: e.quote.capture_id, event_kind: e.event_kind }));
    }
  }
  bump("refs_written", await fileRefs(sb, refs, notes));
  // document date: the reader's value stands only where the producer could not read a dated line; the producer's value keeps its basis and method
  if (plan.document_date) {
    const [cap] = await rowsByIds<{ id: string; document_date: string | null }>(sb, "agent_run_searches", "id, document_date", [plan.document_date.quote.capture_id]);
    if (cap && !cap.document_date) {
      const { error } = await sb.from("agent_run_searches").update({ document_date: plan.document_date.date, document_date_basis: plan.document_date.quote.text, document_date_method: READER_METHOD }).eq("id", cap.id).is("document_date", null);
      if (error) notes.push(`document_date write failed: ${error.message}`);
      else bump("document_dates_written");
    } else bump("document_dates_kept_producer");
  }
  // new entities: a proposed term and a mention (the reader's own words); the recurrence rule adopts, then mintAdoptedTermEntities mints
  if (plan.candidates.length) {
    const keys = plan.candidates.map((c) => normaliseTermKey(c.canonical_name));
    const have = await rowsByIds<{ id: string; term_key: string; kind: string; status: string }>(sb, "vocabulary_terms", "id, term_key, kind, status", keys, "term_key", "id");
    const idOf = new Map(have.filter((t) => t.kind === "term").map((t) => [t.term_key, t]));
    const now = deps.now().toISOString();
    const fresh = plan.candidates.filter((c) => !idOf.has(normaliseTermKey(c.canonical_name)));
    const ins = fresh.length ? await sb.from("vocabulary_terms").insert(fresh.map((c) => ({ kind: "term", term_key: normaliseTermKey(c.canonical_name), label: c.canonical_name, status: "proposed", distinct_items: 1, distinct_sources: sourceId ? 1 : 0, first_seen_at: now, last_seen_at: now, evidence: { detectors: { "brief-terms": 1 }, sample_items: [itemId], sample_surface: [c.quote.text], proposed_kind: c.proposed_kind } }))).select("id, term_key") : { data: [], error: null };
    if (ins.error) notes.push(`vocabulary_terms insert failed: ${ins.error.message}`);
    for (const t of (ins.data ?? []) as { id: string; term_key: string }[]) idOf.set(t.term_key, { id: t.id, term_key: t.term_key, kind: "term", status: "proposed" });
    const rows = plan.candidates.flatMap((c) => { const t = idOf.get(normaliseTermKey(c.canonical_name)); return t && t.status !== "retired" ? [{ term_id: t.id, item_id: itemId, source_id: sourceId, detector: "brief-terms", surface_text: c.quote.text }] : []; });
    const up = rows.length ? await sb.from("vocabulary_mentions").upsert(rows, { onConflict: "term_id,item_id,detector" }) : { error: null };
    if (up.error) notes.push(`vocabulary_mentions write failed: ${up.error.message}`);
    else bump("candidate_mentions", rows.length);
  }
  return { counts, notes };
}
