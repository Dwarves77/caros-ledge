// The flywheel and statutory features: flags are born resolved and de-duplicated on any status, gaps use the canonical jurisdiction, the theme-brief seam
// refuses stale membership (INV-191), the forward-event writer keys on migration 307's identity, connection discovery writes through the owner rules, and the
// statutory runner refuses placeholders and unknown years.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createdBy, GAP_NAMESPACE, planReflect, planResolvedReflectionInserts, reflectResolved, buildSubjectRef } from "@/core/flywheel/flags";
import { detectGaps, jurisdictionKey } from "@/core/flywheel/gaps";
import { computeMemberHash } from "@/core/flywheel/themes";
import { parseThemeBriefEntry, type ThemeContext } from "@/core/briefs/theme-brief-contract";
import { themeBriefSeams } from "@/core/briefs/theme-brief-material";
import { applyThemeBrief } from "@/features/flywheel/theme-brief-seam";
import { discoverForItems, runConnectionDiscovery } from "@/features/flywheel/run-discovery";
import { tagPass } from "@/features/flywheel/tag-pass";
import { forwardEventKey, insertForwardEvents } from "@/features/obligations";
import { statutoryRun, validateStatutoryRows } from "@/features/statutory/run";
import { SUPPORTED_TARGET_YEARS } from "@/features/statutory/rows";

import { connectDb } from "./world.ts";

type Row = Record<string, unknown>;
const NOW = new Date("2026-10-15T00:00:00Z");
const finding = (ref: string, type = "surface_gap") => ({ subjectRef: ref, row: { category: "coverage_gap", subject_type: "system", subject_ref: ref, description: "d", recommended_actions: [], created_by: createdBy(GAP_NAMESPACE, type) } });

test("flags: findings are born resolved and de-duplicated on (subject_ref, created_by) of ANY status", async () => {
  const m = connectDb({ integrity_flags: [{ id: "1", subject_ref: "T1", created_by: createdBy(GAP_NAMESPACE, "surface_gap"), status: "resolved" }] });
  const dry = await reflectResolved(m.db, GAP_NAMESPACE, [finding("T1"), finding("T2")], "pass", NOW.toISOString(), { dry: true });
  assert.deepEqual([dry.inserted, dry.unchanged], [1, 1]);
  assert.equal(m.wrote("integrity_flags", "insert").length, 0);
  const r = await reflectResolved(m.db, GAP_NAMESPACE, [finding("T1"), finding("T2")], "pass", NOW.toISOString());
  assert.deepEqual([r.inserted, r.unchanged, r.failed], [1, 1, 0]);
  const added = (m.tables.integrity_flags as Row[]).find((f) => f.subject_ref === "T2");
  assert.deepEqual([added?.status, added?.resolved_by], ["resolved", "pass"]);
  assert.equal((await reflectResolved(m.db, GAP_NAMESPACE, [finding("T2")], "pass", NOW.toISOString())).inserted, 0, "a reflected finding is not inserted twice");
  const bad = connectDb({}, { failures: [{ table: "integrity_flags", op: "insert", message: "denied" }] });
  const f = await reflectResolved(bad.db, GAP_NAMESPACE, [finding("T9")], "pass", NOW.toISOString());
  assert.deepEqual([f.failed, f.inserted], [1, 0]);
  assert.ok(f.notes[0]?.includes("denied"));
  const down = connectDb({}, { failures: [{ table: "integrity_flags", op: "select", message: "down" }] });
  await assert.rejects(() => reflectResolved(down.db, GAP_NAMESPACE, [finding("T9")], "pass", NOW.toISOString()), /down/);
});

test("planReflect: new rows for findings without an open flag; stale open flags whose finding is no longer made", () => {
  const open = [{ id: "a", subject_ref: "T1", created_by: "c" }, { id: "b", subject_ref: "T2", created_by: "c" }];
  const fresh = [{ subjectRef: "T1", row: { ...finding("T1").row, created_by: "c" } }, { subjectRef: "T3", row: { ...finding("T3").row, created_by: "c" } }];
  const plan = planReflect(open, fresh);
  assert.deepEqual([plan.newRows.length, plan.staleIds, plan.unchanged], [1, ["b"], 1]);
  assert.deepEqual(planReflect(open, fresh, { scopeSubjectRefs: new Set(["T1"]) }).staleIds, []);
  assert.deepEqual(planResolvedReflectionInserts([{ subject_ref: "T1", created_by: "c" }], fresh).unchanged, 1);
  assert.equal(buildSubjectRef("a", "", null, "b"), "a:b");
});

test("gaps: a theme spanning jurisdictions with none of the home ones is a gap; UK is GB; a generic scope names nothing", () => {
  assert.equal(jurisdictionKey("uk"), jurisdictionKey("GB"));
  assert.equal(jurisdictionKey("global"), null);
  const theme = { id: "T", members: ["a", "b"], surfaces: ["regulations", "research"], pivots: [] };
  const gaps = detectGaps([theme], { profile: { jurisdictions: { US: 3, GB: 1 } }, jurisdictionsByMember: { a: ["DE"], b: ["FR"] } });
  assert.deepEqual(gaps.map((g) => g.type).sort(), ["jurisdiction_span_gap", "surface_gap"]);
  const covered = detectGaps([theme], { profile: { jurisdictions: { GB: 3 } }, jurisdictionsByMember: { a: ["UK"], b: ["FR"] } });
  assert.deepEqual(covered.map((g) => g.type), ["surface_gap"], "UK satisfies a GB home jurisdiction");
  const pivot = detectGaps([{ id: "P", members: ["a", "b", "c"], surfaces: ["market"], pivots: [{ id: "a", centrality: 3 }] }]);
  assert.deepEqual(pivot.map((g) => g.type), ["pivot_operations_gap"]);
});

const seamWorld = (members: string[]) => connectDb({ connection_themes: [{ id: "T1", member_ids: members }], theme_briefs: [] }, { unique: { theme_briefs: ["theme_id"] } });
const seamCtx = (members: string[]): ThemeContext => ({ themesById: new Map([["T1", { id: "T1", member_ids: members, surfaces: ["regulations"] }]]), membersById: new Map(), groundedText: new Map(), comparator: themeBriefSeams.comparator });
const seamEntry = (hash: string) => ({ theme_id: "T1", member_hash: hash, title: "T", sections: { connection: "They connect.", meaning: "It matters.", ramifications: "### Regulations\nAn owner is needed.", watch: "Watch the date.", gaps: "" }, claims: [] });
const validBrief = (members: string[], hash = computeMemberHash(members)) => {
  const v = parseThemeBriefEntry(seamEntry(hash), 0, seamCtx(members));
  assert.ok(v.ok, v.ok ? "" : v.errors.join("; "));
  return v.brief;
};

test("theme-brief seam: only a VALIDATED brief is written (a forged object is refused before the database); a stale hash is refused (INV-191); a fresh one is written once under its batch with its structure; the replaced brief is kept", async () => {
  const brief = validBrief(["a", "b"]);
  const m = seamWorld(["a", "b"]);
  const dry = await applyThemeBrief({ sb: m.db, now: () => NOW }, { brief, batch: "theme-briefs-001", dry: true });
  assert.equal(dry.outcome, "ok");
  assert.equal((m.tables.theme_briefs as Row[]).length, 0);
  const forged = await applyThemeBrief({ sb: m.db, now: () => NOW }, { brief: { ...brief } as never, batch: "theme-briefs-001", dry: false });
  assert.equal(forged.outcome, "failed", "a copy or a cast is not a validated brief");
  assert.match(forged.notes[0] ?? "", /did not come from parseThemeBriefEntry/);
  assert.equal(m.mem.rpcCalls.filter((c) => c.name === "apply_theme_brief").length, 0, "the database was not touched");
  const wet = await applyThemeBrief({ sb: m.db, now: () => NOW }, { brief, batch: "theme-briefs-001", dry: false });
  assert.equal(wet.outcome, "ok", wet.notes.join("; "));
  const row = (m.tables.theme_briefs as Row[])[0] as Row;
  assert.deepEqual([row.generated_by, row.member_ids, row.member_count], ["theme-briefs-001", ["a", "b"], 2]);
  assert.deepEqual(Object.keys(row.sections as object).sort(), ["connection", "gaps", "meaning", "ramifications", "watch"]);
  await applyThemeBrief({ sb: m.db, now: () => NOW }, { brief: validBrief(["a", "b"]), batch: "theme-briefs-002", dry: false });
  assert.equal((m.tables.theme_brief_versions as Row[]).length, 1, "the replaced brief is kept");
  const stale = seamWorld(["a", "b", "c"]);
  const refused = await applyThemeBrief({ sb: stale.db, now: () => NOW }, { brief, batch: "theme-briefs-001", dry: false });
  assert.equal(refused.outcome, "failed");
  assert.match(refused.notes[0] ?? "", /member_hash mismatch/);
  assert.equal((stale.tables.theme_briefs as Row[]).length, 0);
  const gone = await applyThemeBrief({ sb: connectDb({ connection_themes: [] }).db, now: () => NOW }, { brief, batch: "theme-briefs-001", dry: false });
  assert.match(gone.notes[0] ?? "", /does not exist/);
  assert.equal(parseThemeBriefEntry({ theme_id: "T1", title: "T" }, 0, seamCtx(["a", "b"])).ok, false);
});

test("forward events: the migration-307 key (item, kind, date, md5 of the text) de-duplicates; a collision retries row by row; stale supports are reported", async () => {
  const ev = (d: string, text: string) => ({ event_date: d, date_precision: "day", event_kind: "compliance_deadline", obligation_text: text, source_claim_id: "k1" }) as never;
  assert.equal(forwardEventKey({ event_date: "2026-01-01", event_kind: "x", obligation_text: "a" }), forwardEventKey({ event_date: "2026-01-01", event_kind: "x", obligation_text: "a" }));
  assert.notEqual(forwardEventKey({ event_date: "2026-01-01", event_kind: "x", obligation_text: "a" }), forwardEventKey({ event_date: "2026-01-01", event_kind: "x", obligation_text: "b" }));
  const m = connectDb({ item_forward_events: [{ id: "old", intelligence_item_id: "i1", event_date: "2026-01-01", event_kind: "compliance_deadline", obligation_text: "held", source_claim_id: "gone", source_section_id: null }] });
  const r = await insertForwardEvents(m.db, "i1", [ev("2026-01-01", "held"), ev("2026-02-01", "new"), ev("2026-02-01", "new")], { claimIds: new Set(["k1"]), sectionIds: new Set() });
  assert.deepEqual([r.attempted, r.inserted, r.staleIds], [1, 1, ["old"]]);
  assert.equal((m.tables.item_forward_events as Row[]).length, 2, "stale support is reported, never deleted");
  const dry = await insertForwardEvents(m.db, "i1", [ev("2026-03-01", "n2")], { claimIds: new Set(), sectionIds: new Set() }, { dry: true });
  assert.deepEqual([dry.attempted, dry.inserted], [1, 0]);
  const racing = connectDb({ item_forward_events: [] }, { failures: [{ table: "item_forward_events", op: "insert", message: "dup", code: "23505", when: (c) => Array.isArray(c.payload) }] });
  const rr = await insertForwardEvents(racing.db, "i1", [ev("2026-04-01", "a"), ev("2026-04-02", "b")], { claimIds: new Set(["k1"]), sectionIds: new Set() });
  assert.deepEqual([rr.collision, rr.inserted], [true, 2], "the non-colliding rows still land");
  const hard = connectDb({}, { failures: [{ table: "item_forward_events", op: "insert", message: "denied" }] });
  await assert.rejects(() => insertForwardEvents(hard.db, "i1", [ev("2026-05-01", "x")], { claimIds: new Set(), sectionIds: new Set() }), /insert failed/);
});

const sigItem = (id: string, over: Row = {}): Row => ({ id, item_type: "regulation", domain: 1, title: `Item ${id}`, canonical_instrument_key: null, instrument_entity_id: null, source_id: "s1", operational_scenario_tags: [], compliance_object_tags: [], jurisdictions: [], jurisdiction_iso: [], topic_tags: [], created_at: "2026-01-01T00:00:00Z", provenance_status: "verified", is_archived: false, ...over });
const discoveryWorld = (edges: Row[] = [], corrections: Row[] = []) => connectDb({ intelligence_items: [sigItem("a"), sigItem("b"), sigItem("c", { source_id: "other" })], item_cross_references: edges, item_corrections: corrections, obligation_objects: [] }, { unique: { item_cross_references: ["source_item_id", "target_item_id"] } });

test("connection discovery: a shared source scores 0.4, is written as a provenance_discovery edge, and a manual edge or a tombstone is left alone", async () => {
  const m = discoveryWorld();
  const dry = await runConnectionDiscovery({ sb: m.db }, "a", { dry: true });
  assert.equal(dry.found, 1);
  assert.equal(m.wrote("item_cross_references", "upsert").length, 0);
  const r = await runConnectionDiscovery({ sb: m.db }, "a");
  assert.equal(r.write?.written, 1);
  const row = (m.tables.item_cross_references as Row[])[0];
  assert.deepEqual([row?.origin, row?.relationship, row?.target_item_id], ["provenance_discovery", "related", "b"]);
  assert.equal((await runConnectionDiscovery({ sb: m.db }, "missing")).missing, true);
  const manual = discoveryWorld([{ id: "x", source_item_id: "a", target_item_id: "b", relationship: "supersedes", origin: "manual", score: 1, basis: [] }]);
  const rm = await runConnectionDiscovery({ sb: manual.db }, "a");
  assert.equal(rm.write?.skippedForeignOrigin, 1);
  assert.equal((manual.tables.item_cross_references as Row[])[0]?.relationship, "supersedes");
  const tomb = discoveryWorld([], [{ id: "c1", item_id: "a", target_kind: "connection", target_ref: "b", op: "remove", created_at: "2026-01-01T00:00:00Z", revoked_at: null }]);
  assert.equal((await runConnectionDiscovery({ sb: tomb.db }, "a")).write?.skippedTombstoned, 1);
  assert.equal((tomb.tables.item_cross_references as Row[]).length, 0);
  const all = await discoverForItems({ sb: discoveryWorld().db }, { ids: ["a"], dry: true });
  assert.deepEqual([all.outcome, all.counts.edges_found], ["ok", 1]);
  assert.equal((await discoverForItems({ sb: discoveryWorld().db }, { dry: true })).outcome, "failed", "ids or since, exactly one");
});

test("tagPass: dry writes nothing; apply tags from the title and records one resolved decision flag; a second pass changes nothing", async () => {
  const tables = () => ({ intelligence_items: [{ id: "i1", title: "Methane slip and onshore power supply", what_is_it: "", summary: "", full_brief: "", canonical_instrument_key: null, operational_scenario_tags: [], compliance_object_tags: [], topic_tags: [], is_archived: false, provenance_status: "verified" }], integrity_flags: [], item_corrections: [], vocabulary_terms: [] });
  const dry = connectDb(tables());
  await tagPass({ sb: dry.db, now: () => NOW }, { ids: ["i1"], dry: true, discover: false });
  assert.equal(dry.writes.filter((w) => w.op !== "select").length, 0);
  const m = connectDb(tables());
  const first = await tagPass({ sb: m.db, now: () => NOW }, { ids: ["i1"], dry: false, discover: false });
  assert.notEqual(first.outcome, "failed", first.notes.join("; "));
  const snapshot = JSON.stringify(m.tables.intelligence_items);
  const flags = (m.tables.integrity_flags as Row[]).length;
  await tagPass({ sb: m.db, now: () => NOW }, { ids: ["i1"], dry: false, discover: false });
  assert.equal(JSON.stringify(m.tables.intelligence_items), snapshot);
  assert.equal((m.tables.integrity_flags as Row[]).length, flags, "no duplicate decision flag");
});

// ------------------------------------------------------------------ statutory

test("statutory: the table holds 2025 to 2050 from the constants; a placeholder or an unrated host refuses the file; an unknown year is refused, not guessed", async () => {
  assert.deepEqual(Object.keys(SUPPORTED_TARGET_YEARS), ["2025", "2030", "2035", "2040", "2045", "2050"]);
  assert.ok(validateStatutoryRows({ rows: [] }).length > 0, "an empty file is not apply-ready");
  assert.ok(validateStatutoryRows({ _file_status: "SYNTHETIC fixture", rows: [{}] }).some((v) => v.includes("placeholder")));
  const block = (source: unknown) => ({ value: 1, unit: "u", citation: "c", asOf: { eventDate: "2026-01-01" }, derivation: "observed", originClass: "official", lifecycle: "verified", admissibility: "filing_ok", baseConfidence: 1, source });
  const good = { url: "https://eur-lex.europa.eu/x", article: "Article 4", quote: "q", verified_at: "2026-01-01" };
  const row = (year: number, source: unknown = good) => ({ shipKey: "SHIP-1", targetYear: year, ghgIntensityActual: block(source), energyUsedMJ: block(source), consecutiveDeficitYears: block(source) });
  assert.deepEqual(validateStatutoryRows({ rows: [row(2025)] }), []);
  assert.ok(validateStatutoryRows({ rows: [row(2025, { ...good, url: "https://random-blog.example.net/x" })] }).some((v) => v.includes("does not resolve")));
  assert.ok(validateStatutoryRows({ rows: [row(2025, { url: "https://eur-lex.europa.eu/x" })] }).some((v) => v.includes("required")));
  assert.ok(validateStatutoryRows({ rows: [row(2025, { ...good, url: "not a url" })] }).some((v) => v.includes("not a valid absolute URL")));
  const deps = { sb: connectDb({}).db, now: () => NOW, statutory: { computeStatutory: () => { throw new Error("must not run"); }, formulaVersion: "1", statuteCitation: "c", unitPriceEurPerTVlsfoe: 2400 } };
  const bad = await statutoryRun(deps as never, { dry: true, file: { rows: [row(2025, { url: "x" })] } });
  assert.equal(bad.outcome, "failed", "a violating file writes nothing and runs nothing");
  const year = await statutoryRun(deps as never, { dry: true, file: { rows: [row(2031)] } });
  assert.equal(year.counts.refused, 1);
  assert.match(year.data?.perItem[0]?.detail ?? "", /not in Article 4\(2\)/);
});
