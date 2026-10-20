// Entities and the ops backfills: deterministic ids, the crosswalk's check digits, the lineage partition (INV-206), mention detection and typing, source role,
// and the five ops runtimes (dry writes nothing, apply is idempotent, a failed read throws).
import assert from "node:assert/strict";
import { test } from "node:test";

import { identifierRow, VALIDATORS } from "@/core/entities/crosswalk";
import { canonicalJurisdictionCode, corridorSeed, entityId, hostFromUrl } from "@/core/entities/id";
import { assertEntityId, parseCorridorName } from "@/core/entities/kinds";
import { LINEAGE_GAP_CREATED_BY, partitionLineageWrites, planLineageGapTargets } from "@/core/entities/lineage";
import { assertMoatBoundary, planLinkWrites } from "@/core/entities/mentions";
import { distinctNormalized, planJurisdiction } from "@/core/entities/plan";
import { congruence, sourceRole } from "@/core/entities/source-role";
import { formatCorridorLabel } from "@/core/entities/unlocode-names";
import { backfillDerivationEdges, backfillEntities, backfillLineageEdges, seedCorridors, seedDerivedValues } from "@/features/propagation/ops";

import { connectDb } from "./world.ts";

type Row = Record<string, unknown>;
const NOW = new Date("2026-10-15T00:00:00Z");

test("entity ids are deterministic, kind-scoped and refuse a degenerate seed", () => {
  assert.equal(entityId("jurisdiction", "de"), entityId("jurisdiction", " DE "));
  assert.notEqual(entityId("jurisdiction", "DE"), entityId("organisation", "DE"));
  assert.match(entityId("organisation", "https://www.Example.org/path"), /^cl:organisation:[0-9a-f]{16}$/);
  assert.equal(entityId("organisation", "https://www.example.org/x"), entityId("organisation", "example.org"));
  assert.throws(() => entityId("jurisdiction", "  "), /empty normalized seed/);
  assert.throws(() => assertEntityId("nope"));
  assert.equal(hostFromUrl("https://eur-lex.europa.eu/x"), "eur-lex.europa.eu");
});

test("a corridor seed is ORIGIN-DEST:mode with the canonical mode; sea is not a mode", () => {
  assert.equal(corridorSeed({ origin: "cnsha", dest: "nlrtm", mode: "ocean" }), "CNSHA-NLRTM:ocean");
  assert.throws(() => corridorSeed({ origin: "CNSHA", dest: "NLRTM", mode: "teleport" }), /unrecognised mode/);
  assert.throws(() => corridorSeed({ origin: "CNSHA", dest: "", mode: "ocean" }), /requires both/);
  assert.deepEqual(parseCorridorName("CNSHA-NLRTM:ocean"), { origin: "CNSHA", dest: "NLRTM", mode: "ocean" });
  assert.equal(parseCorridorName("garbage"), null);
  assert.equal(formatCorridorLabel({ origin: "CNSHA", dest: "NLRTM", mode: "ocean" }).includes("Shanghai"), true);
});

test("jurisdiction aliases: UK is GB, EL is GR", () => {
  assert.equal(canonicalJurisdictionCode("uk"), "GB");
  assert.equal(canonicalJurisdictionCode(" el "), "GR");
  assert.equal(canonicalJurisdictionCode(""), null);
});

test("the crosswalk validates check digits and refuses a blank asserter or an unknown scheme", () => {
  assert.equal(VALIDATORS.LEI("5493001KJTIIGC8Y1R12"), true);
  assert.equal(VALIDATORS.LEI("5493001KJTIIGC8Y1R13"), false);
  assert.equal(VALIDATORS.IMO_SHIP("9074729"), true);
  assert.equal(VALIDATORS.IMO_SHIP("9074720"), false);
  assert.equal(VALIDATORS.ISO6346("CSQU3054383"), true);
  assert.equal(VALIDATORS.ISO6346("CSQU3054384"), false);
  assert.equal(VALIDATORS.ORCID("0000-0002-1825-0097"), true);
  assert.equal(VALIDATORS.ORCID("0000-0002-1825-0098"), false);
  const id = entityId("jurisdiction", "DE");
  assert.equal(identifierRow(id, "ISO3166_1", "DE", "t", { now: NOW }).asserted_at, NOW.toISOString());
  assert.throws(() => identifierRow(id, "ISO3166_1", "DE", " ", { now: NOW }), /assertedBy/);
  assert.throws(() => identifierRow(id, "ISO3166_1", "Germany", "t", { now: NOW }), /does not validate/);
  assert.throws(() => identifierRow(id, "NOPE" as never, "x", "t", { now: NOW }), /unknown identifier scheme/);
});

const edge = (relationship: string, over: Row = {}) => ({ table: "item_cross_references", row: { source_item_id: "a", target_item_id: "b", relationship, origin: "entity_extraction", basis: [{ signal: "lineage", detail: "d" }], ...over } });
const existing = (o: Row) => new Map([["a|b", { id: "x", source_item_id: "a", target_item_id: "b", relationship: "related", basis: [], ...o }]]) as never;

test("INV-206 partition: manual and foreign generic claims are skipped, a different type is a conflict, a tombstone is respected, an upgrade merges the basis", () => {
  const p = (w: ReturnType<typeof edge>, ex?: Map<string, never>, tomb?: Set<string>) => partitionLineageWrites([w], ex, tomb);
  assert.equal(p(edge("amends"), existing({ origin: "manual", relationship: "related" })).skippedForeign.length, 1);
  assert.equal(p(edge("related"), existing({ origin: "provenance_discovery" })).skippedForeign.length, 1, "a generic claim on a foreign row");
  assert.equal(p(edge("amends"), existing({ origin: "provenance_discovery", relationship: "implements" })).conflicts.length, 1);
  assert.equal(p(edge("amends"), undefined, new Set(["a|b"])).skippedTombstoned.length, 1);
  assert.equal(p(edge("amends")).inserts.length, 1);
  const up = p(edge("amends"), existing({ origin: "provenance_discovery", relationship: "related" })).upgrades;
  assert.deepEqual([up.length, up[0]?.relationship, up[0]?.basis_added], [1, "amends", 1]);
  assert.equal(p(edge("amends"), existing({ origin: "entity_extraction", relationship: "amends", basis: [{ signal: "lineage", detail: "d" }] })).unchanged.length, 1, "a re-run changes nothing");
});

test("mentions: identifiers, the lineage cue decides the type, the moat boundary admits only edges and flags", () => {
  const corpus = [{ id: "p", title: "FuelEU Maritime", instrument_identifier: "Regulation (EU) 2023/1805" }, { id: "s", title: "Guidance", instrument_identifier: null }];
  const typed = (text: string) => planLinkWrites(text, corpus, "s").find((w) => w.table === "item_cross_references")?.row;
  assert.equal(typed("This amends Regulation (EU) 2023/1805 and cites 2024/825.")?.target_item_id, "p", "the identifier in the text is the item that holds it");
  assert.equal(typed("This Regulation, amending Regulation (EU) 2023/1805, ...")?.relationship, "amends");
  assert.equal(typed("See Regulation (EU) 2023/1805.")?.relationship, "related");
  assert.equal(typed("This guidance, implementing Regulation (EU) 2023/1805, covers ships.")?.relationship, "implements");
  assert.throws(() => assertMoatBoundary([{ table: "section_claim_provenance" }]), /moat boundary/);
});

test("source role and the intake congruence rule", () => {
  assert.equal(sourceRole("https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1805"), "primary");
  assert.equal(congruence("regulation", "https://example.com/news/article-1").itemType, "market_signal");
});

test("planners return only what is not already there", () => {
  const first = planJurisdiction(distinctNormalized(["de", "DE", "fr", ""]), { assertedBy: "t", now: NOW });
  assert.deepEqual(first.entities.map((e) => e.canonical_name).sort(), ["DE", "FR"]);
  const again = planJurisdiction(["DE", "FR"], { assertedBy: "t", now: NOW, existingEntityIds: new Set(first.entities.map((e) => e.entity_id)), existingIdentifierKeys: new Set(first.identifiers.map((i) => `${i.entity_id}|${i.scheme}|${i.value}`)) });
  assert.deepEqual([again.entities.length, again.identifiers.length], [0, 0]);
});

// ---------------------------------------------------------------------- ops

test("seed-corridors: the convention scan, the seed fallback, the planners and the scope pairs", async () => {
  const empty = { market_series: [], regional_data_facts: [], entities: [], entity_identifiers: [], entity_scope: [] };
  const dry = async (tables: Record<string, unknown[]>) => seedCorridors({ sb: connectDb({ ...empty, ...tables }).db, now: () => NOW }, { dry: true });
  // no live data names a corridor: the four confirmed seeds are used and all four are to create
  const fallback = await dry({});
  assert.deepEqual([fallback.counts.candidates, fallback.counts.to_create], [4, 4]);
  assert.match(fallback.notes.join("|"), /confirmed seeds are used/);
  // the convention scan reads series keys and fact labels: a bad name is no candidate, a repeat is one
  const found = await dry({ market_series: [{ series_key: "corridor:DEHAM-USNYC:ocean" }, { series_key: "corridor:DEHAM-USNYC:ocean" }, { series_key: "corridor:bad" }], regional_data_facts: [{ fact_label: "corridor:CNSHA-NLRTM:ocean" }] });
  assert.deepEqual([found.counts.candidates, found.counts.to_create], [2, 2]);
  assert.doesNotMatch(found.notes.join("|"), /confirmed seeds are used/);
  // an existing corridor is not planned again; a corridor with no display name is labelled, one with a name is not
  const existing = { entity_id: entityId("corridor", "CNSHA-NLRTM:ocean"), kind: "corridor", canonical_name: "CNSHA-NLRTM:ocean", display_name: null, status: "active" };
  const planned = await dry({ entities: [existing, { ...existing, entity_id: "c2", canonical_name: "bad" }, { ...existing, entity_id: "c3", canonical_name: "DEHAM-USNYC:ocean", display_name: "x" }] });
  assert.equal(planned.counts.display_name_backfill, 1, "only the unnamed corridor that parses is labelled");
  assert.equal(planned.counts.to_create, 3, "the four seeds, less the one already held");
  // the scope pairs: the first two letters of each endpoint, one pair per corridor and country; a name that does not parse is skipped by name
  const pairs = await dry({ entities: [existing, { ...existing, entity_id: "c2", canonical_name: "bad" }], market_series: [{ series_key: "corridor:CNSHA-NLRTM:ocean" }] });
  assert.match(pairs.notes.join("|"), /corridor c2: canonical_name does not match the ORIGIN-DEST:mode convention/);
  assert.equal(pairs.counts.scope_rows_planned, 2, "CN and NL for the one corridor that parses");
});

test("seed-corridors: dry writes nothing; apply writes corridors, jurisdictions and scope once; a second apply writes nothing", async () => {
  const tables = () => ({ market_series: [], regional_data_facts: [], entities: [], entity_identifiers: [], entity_scope: [] });
  const dry = connectDb(tables());
  const d = await seedCorridors({ sb: dry.db, now: () => NOW }, { dry: true });
  assert.equal(d.outcome, "ok");
  assert.equal(d.counts.to_create, 4);
  assert.equal(dry.writes.filter((w) => w.op !== "select").length, 0);
  const m = connectDb(tables());
  const a = await seedCorridors({ sb: m.db, now: () => NOW }, { dry: false });
  assert.equal(a.outcome, "ok", a.notes.join("; "));
  assert.equal(a.counts.created, 4);
  const scope = m.tables.entity_scope as Row[];
  assert.ok(scope.length >= 4 && scope.every((r) => r.relation === "touches_jurisdiction" && r.attributed_to === "rule:corridor-jurisdiction-unlocode-v1" && r.confidence === 1));
  const before = [m.tables.entities!.length, scope.length];
  const b = await seedCorridors({ sb: m.db, now: () => NOW }, { dry: false });
  assert.equal(b.counts.created, 0);
  assert.deepEqual([m.tables.entities!.length, (m.tables.entity_scope as Row[]).length], before);
});

test("seed-corridors: a failed read throws; it is never an empty corpus", async () => {
  const m = connectDb({}, { failures: [{ table: "market_series", op: "select", message: "down" }] });
  await assert.rejects(() => seedCorridors({ sb: m.db, now: () => NOW }, { dry: false }), /down/);
});

test("backfill-entities: dry counts, apply writes entities, refs and the foreign keys, a second apply writes nothing", async () => {
  const tables = () => ({
    intelligence_items: [{ id: "i1", jurisdiction_iso: ["DE", "EU"], canonical_instrument_key: "32023R1805", instrument_entity_id: null }],
    regions: [{ id: "r1", iso_codes: ["DE"] }],
    sources: [{ id: "s1", url: "https://eur-lex.europa.eu/x", organisation_entity_id: null }],
    entities: [], entity_identifiers: [], entity_refs: [],
  });
  const dry = connectDb(tables());
  const d = await backfillEntities({ sb: dry.db, now: () => NOW }, { dry: true });
  assert.equal(d.outcome, "ok");
  assert.equal(dry.writes.filter((w) => w.op !== "select").length, 0);
  assert.ok((d.counts.jurisdiction_planned ?? 0) >= 2);
  const m = connectDb(tables());
  const a = await backfillEntities({ sb: m.db, now: () => NOW }, { dry: false });
  assert.equal(a.outcome, "ok", a.notes.join("; "));
  assert.ok((m.tables.intelligence_items as Row[])[0]?.instrument_entity_id);
  assert.ok((m.tables.sources as Row[])[0]?.organisation_entity_id);
  const n = [m.tables.entities!.length, m.tables.entity_identifiers!.length, m.tables.entity_refs!.length];
  const b = await backfillEntities({ sb: m.db, now: () => NOW }, { dry: false });
  assert.equal(b.outcome, "ok");
  assert.deepEqual([m.tables.entities!.length, m.tables.entity_identifiers!.length, m.tables.entity_refs!.length], n, "idempotent");
  const only = connectDb(tables());
  await backfillEntities({ sb: only.db, now: () => NOW }, { dry: false, kinds: ["organisation"] });
  assert.ok((only.tables.entities as Row[]).every((e) => e.kind === "organisation"));
});

test("backfill-entities: a failed insert is counted and the run is not ok", async () => {
  const m = connectDb({ intelligence_items: [{ id: "i1", jurisdiction_iso: ["DE"] }], regions: [], entities: [], entity_identifiers: [], entity_refs: [] }, { failures: [{ table: "entities", op: "insert", message: "denied" }] });
  const r = await backfillEntities({ sb: m.db, now: () => NOW }, { dry: false, kinds: ["jurisdiction"] });
  assert.notEqual(r.outcome, "ok");
  assert.ok(r.notes.join(" ").includes("denied"));
});

test("backfill-lineage-edges: snapshot before any write, typed edge inserted, manual edge untouched, dry writes nothing, rerun unchanged", async () => {
  const tables = () => ({
    intelligence_items: [
      { id: "p", title: "FuelEU Maritime", instrument_identifier: "Regulation (EU) 2023/1805", is_archived: false, full_brief: "" },
      { id: "s", title: "Guidance", instrument_identifier: null, is_archived: false, full_brief: "This guidance, implementing Regulation (EU) 2023/1805, covers ships and operators." },
      { id: "t", title: "Other", instrument_identifier: null, is_archived: false, full_brief: "short" },
    ],
    intelligence_item_sections: [],
    item_cross_references: [{ id: "x", source_item_id: "t", target_item_id: "p", relationship: "supersedes", origin: "manual", basis: [] }],
    item_corrections: [], integrity_flags: [],
  });
  const dry = connectDb(tables());
  const d = await backfillLineageEdges({ sb: dry.db, now: () => NOW }, { dry: true });
  assert.equal(dry.writes.filter((w) => w.op !== "select").length, 0);
  assert.equal(d.data?.snapshot.count, 1);
  const m = connectDb(tables(), { unique: { item_cross_references: ["source_item_id", "target_item_id"] } });
  const a = await backfillLineageEdges({ sb: m.db, now: () => NOW }, { dry: false });
  assert.equal(a.outcome, "ok", a.notes.join("; "));
  const edges = m.tables.item_cross_references as Row[];
  assert.equal(edges.find((e) => e.source_item_id === "s" && e.target_item_id === "p")?.relationship, "implements");
  assert.equal(edges.find((e) => e.source_item_id === "t")?.origin, "manual");
  assert.equal(a.data?.snapshot.md5, d.data?.snapshot.md5, "the snapshot is of the state before the write");
  const b = await backfillLineageEdges({ sb: m.db, now: () => NOW }, { dry: false });
  assert.equal(b.counts.inserted, 0);
  assert.equal(b.counts.upgraded, 0);
});

test("seed-derived-values: a source that may not be re-served is counted, not seeded; a refusal is counted; dry writes nothing", async () => {
  const rows = [
    { factor_id: "f1", quantity_basis: "tkm", ttw_co2e: 1, wtw_co2e: 2, wtt_co2e: 1, source_key: "desnz_ghg_factors", origin_class: "official", pedigree: 1, superseded_by: null },
    { factor_id: "f2", quantity_basis: "tkm", ttw_co2e: 1, wtw_co2e: 2, wtt_co2e: 1, source_key: "glec_framework", origin_class: "official", pedigree: 1, superseded_by: null },
    { factor_id: "f3", quantity_basis: "bad", ttw_co2e: null, wtw_co2e: null, wtt_co2e: null, source_key: "desnz_ghg_factors", origin_class: "official", pedigree: 1, superseded_by: null },
  ];
  const carbonIntensity = (f: { quantity_basis: string }) => (f.quantity_basis === "tkm" ? ({ ok: true, valueGPerUnit: 5, unit: "g/tkm" } as const) : ({ ok: false, reason: "x" } as const));
  const dry = connectDb({ emission_factors: rows });
  const d = await seedDerivedValues({ sb: dry.db, now: () => NOW, carbonIntensity }, { dry: true });
  assert.equal(d.counts.total, 3);
  assert.equal(dry.writes.filter((w) => w.op !== "select").length, 0);
  assert.equal((d.counts.licence_blocked ?? 0) + (d.counts.refused ?? 0) + (d.counts.would_create ?? 0), 3);
  assert.equal(d.counts.licence_blocked, 1, "a licence-gated source is not clear to re-serve");
  const regs: unknown[] = [];
  const live = connectDb({ emission_factors: rows }, { rpc: (n, a) => (regs.push([n, a]), { data: [{ value_id: "v1", authored: true }] }) });
  const r = await seedDerivedValues({ sb: live.db, now: () => NOW, carbonIntensity }, { dry: false });
  assert.equal(r.outcome, "ok");
  assert.equal(r.counts.created, d.counts.would_create);
  assert.equal(regs.length, d.counts.would_create);
});

test("backfill-derivation-edges: dry counts the candidates and calls no author; apply passes them through; an errored figure is partial", async () => {
  const tables = { emission_factors: [{ factor_id: "f1", source_key: "desnz_ghg_factors", superseded_by: null }, { factor_id: "f2", source_key: "desnz_ghg_factors", superseded_by: "f1" }], market_series: [{ series_key: "k" }, { series_key: "k" }, { series_key: "j" }] };
  let called = 0;
  const authors = { authorCarbonIntensityEdges: async () => (called++, { authored: 1, errored: 0 }), authorMarketSeriesDeltaEdges: async () => (called++, { authored: 1, errored: 1 }) };
  const dry = await backfillDerivationEdges({ sb: connectDb(tables).db, now: () => NOW, authors }, { dry: true });
  assert.deepEqual([dry.counts.emission_factors, dry.counts.market_series, called], [1, 2, 0]);
  const live = await backfillDerivationEdges({ sb: connectDb(tables).db, now: () => NOW, authors }, { dry: false });
  assert.equal(called, 2);
  assert.equal(live.outcome, "partial");
});

test("INV-019: a lineage-gap flag stays an acquisition target only while its parent is absent; once held it is resolvable", () => {
  const flag = (id: string, ident: string) => ({ id, subject_ref: "s", created_by: LINEAGE_GAP_CREATED_BY, recommended_actions: [{ action: "acquire_parent_instrument", rationale: `item implements ${ident}, which does not resolve to any item in the corpus` }] });
  const absent = planLineageGapTargets([flag("f1", "Regulation (EU) 2023/1805")], [{ id: "s", title: "Guidance", instrument_identifier: null }]);
  assert.deepEqual([absent.targets.length, absent.resolvable.length], [1, 0]);
  const held = planLineageGapTargets([flag("f1", "Regulation (EU) 2023/1805")], [{ id: "s", title: "Guidance", instrument_identifier: null }, { id: "p", title: "FuelEU Maritime", instrument_identifier: "Regulation (EU) 2023/1805" }]);
  assert.deepEqual([held.targets.length, held.resolvable.length, held.resolvable[0]?.parents[0]?.parent_item_ids], [0, 1, ["p"]]);
  const none = planLineageGapTargets([{ id: "f2", subject_ref: null, created_by: LINEAGE_GAP_CREATED_BY }, { id: "f3", subject_ref: "s", created_by: "other:flag" }], []);
  assert.deepEqual([none.residue.length, none.targets.length], [1, 0], "a flag with no subject is residue; another producer's flag is not read");
});
