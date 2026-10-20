// Research: the authority buckets, the deterministic assessment (INV-249), the walker's publisher placement and mint check, and the free theme rules.
import assert from "node:assert/strict";
import { test } from "node:test";

import { entityId } from "@/core/entities";
import { runProducer } from "@/core/producers/runner";
import { aggregateAuthorityDistribution, scoreSource } from "@/features/research/authority-score";
import { fetchLiveCandidates, researchAssessment } from "@/features/research/assessment-producer";
import { assessItem, extractDoiCandidate, hasChanged, toRow, type AssessInput } from "@/features/research/model/assess";
import { classifyTheme, THEME_VALUES } from "@/features/research/theme-rules";
import { researchWalker, walkResearch, type WalkerDeps } from "@/features/research/walker";

import { memoryDb } from "../_support/memory-db.ts";
import { makeWorld, makeDeps as mintDeps } from "../mint/world.ts";

import { makeDeps, NOW, parseDoc } from "./support.ts";

// ---- authority ----
test("authority buckets: a vendor is capped and flagged, an unknown role is never medium, a retracted work is never high-authority, funding must be disclosed AND independent", () => {
  const openAlex = (o: { institution?: object; funding?: object | null; work?: object } = {}) => scoreSource({ kind: "openalex", sourceId: "s1", institution: { type: "education" }, funding: { disclosed: true, funderIsCommercialBeneficiary: false }, work: { isRetracted: false }, ...o });
  assert.equal(openAlex().bucket, "highAuthorityIndependent");
  assert.equal(openAlex({ work: { isRetracted: true } }).bucket, "medium");
  assert.equal(openAlex({ funding: null }).bucket, "medium");
  assert.equal(openAlex({ institution: { type: "company" } }).bucket, "vendorFlagged");
  assert.equal(openAlex({ institution: { roleClass: "industry_association" } }).bucket, "vendorFlagged");
  assert.equal(openAlex({ institution: {} }).bucket, "unknown");
  assert.equal(openAlex({ funding: { disclosed: true, funderIsCommercialBeneficiary: false } }).fundingIndependence, "independent");
  assert.equal(openAlex({ funding: { disclosed: true, funderIsCommercialBeneficiary: true } }).fundingIndependence, "dependent");
  assert.equal(openAlex({ funding: { disclosed: false, funderIsCommercialBeneficiary: false } }).fundingIndependence, "unknown");
  assert.equal(openAlex({ funding: null }).fundingIndependence, "unknown");
});

test("authority: named overrides beat the institution type, the grey-literature path reads mandate not citations, reception is a velocity under 24 months (never FWCI) and absence of a footprint is not low authority", () => {
  const roleOf = (institution: object) => scoreSource({ kind: "openalex", sourceId: "s", institution }).roleClass;
  assert.equal(roleOf({ displayName: "International Energy Agency", type: "company" }), "intergovernmental");
  assert.equal(roleOf({ displayName: "ICCT" }), "institute_ngo");
  assert.equal(roleOf({ type: "education" }), "university");
  assert.equal(roleOf({ type: "company" }), "vendor");
  assert.equal(roleOf({ displayName: "Mystery Org" }), "unknown");
  assert.equal(roleOf({ roleClass: "bogus", displayName: "ICCT" }), "institute_ngo", "an unlisted role class is ignored");
  const grey = scoreSource({ kind: "grey_literature", sourceId: "g1", displayName: "IMO", funding: { disclosed: true, funderIsCommercialBeneficiary: false } });
  assert.equal(grey.bucket, "highAuthorityIndependent");
  assert.equal(grey.method, "grey_literature_non_citation");
  assert.equal(grey.reception.metric, "unknown");
  assert.match(grey.reception.method, /absence of a citation footprint/);
  const receptionOf = (work: object) => scoreSource({ kind: "openalex", sourceId: "s", work }, { now: NOW }).reception;
  const young = receptionOf({ publicationDate: "2026-04-15", citedByCount: 12, fwci: 3 });
  assert.equal(young.metric, "velocity");
  assert.ok(young.value !== null && young.value > 1.5 && young.value < 3);
  assert.equal(receptionOf({ publicationDate: "2020-01-01", citationNormalizedPercentile: 0.9, fwci: 3 }).metric, "citation_normalized_percentile");
  assert.equal(receptionOf({ publicationDate: "2020-01-01", fwci: 3 }).metric, "fwci");
  assert.equal(receptionOf({ publicationDate: "2020-01-01" }).metric, "unknown");
  assert.throws(() => scoreSource({ kind: "alien", sourceId: "x" }), /unknown record.kind/);
  assert.throws(() => scoreSource({ kind: "openalex" }), /sourceId/);
  const dist = aggregateAuthorityDistribution([grey, scoreSource({ kind: "grey_literature", sourceId: "g2", displayName: "Some Vendor", roleClass: "vendor", integrityConcern: true })]);
  assert.deepEqual([dist.highAuthorityIndependent, dist.vendorFlagged, dist.integrityFlagged, dist.medium], [1, 1, 1, 0]);
});

// ---- assessment ----
const NOWD = new Date("2026-10-01T00:00:00Z");
const input = (o: Partial<AssessInput> = {}): AssessInput => ({ id: "item-1", text: "A demonstration pilot project for hydrogen trucks.", sourceTier: 3, citationCount: null, forwardEvents: [], entityId: null, ...o });
const ev = (id: string, date: string, text: string, cite: string | null = null) => ({ id, event_date: date, obligation_text: text, source_citation: cite });

test("assessment rules: R1 a dated statutory instrument (CONFIRMED), R3 a named roadmap date (CONFIRMED), R4 a prior from maturity (HYPOTHESIS), else a refusal; signposts only for a future anchor", () => {
  const r1 = assessItem(input({ text: "FuelEU compliance date applies to ships", forwardEvents: [ev("e1", "2027-01-01", "FuelEU phase-in begins")], entityId: "cl:instrument:aaaa" }), { now: NOWD });
  assert.deepEqual([r1.horizon?.rule, r1.horizon?.kind, r1.horizon?.band, r1.statusToken], ["R1", "obligation", "NOW", "CONFIRMED"]);
  assert.equal(r1.signposts.length, 1);
  assert.equal(r1.signposts[0]?.seed, "signpost:item-1:e1");
  assert.deepEqual(r1.signposts[0]?.predicate.by, "2027-01-01");
  const past = assessItem(input({ text: "FuelEU compliance date applies", forwardEvents: [ev("e1", "2026-01-01", "FuelEU phase-in")], entityId: "cl:instrument:aaaa" }), { now: NOWD });
  assert.equal(past.signposts.length, 0, "an anchor already passed states no expectation");
  const r3 = assessItem(input({ text: "Hydrogen trucks", forwardEvents: [ev("e2", "2033-06-01", "deployment", "IEA roadmap")] }), { now: NOWD });
  assert.deepEqual([r3.horizon?.rule, r3.horizon?.band, r3.horizon?.confidence, r3.statusToken], ["R3", "MID", "medium", "CONFIRMED"]);
  const r4 = assessItem(input(), { now: NOWD });
  assert.deepEqual([r4.horizon?.rule, r4.horizon?.band, r4.statusToken, r4.technicalMaturity?.low], ["R4", "NEAR", "HYPOTHESIS", 8]);
  const refused = assessItem(input({ text: "nothing forecastable here" }), { now: NOWD });
  assert.equal(refused.horizon, null);
  assert.equal(refused.refusalReason, "no_dated_basis", "the producer stores a reason code, not prose (surfaces:5)");
  assert.equal(refused.statusToken, "HYPOTHESIS");
  assert.equal(assessItem(input({ citationCount: 0 })).credibilityEvidenceScore, "limited");
  assert.equal(assessItem(input({ citationCount: 7 })).credibilityEvidenceScore, "robust");
  assert.equal(assessItem(input({ citationCount: null })).credibilityEvidenceScore, null);
  assert.deepEqual(assessItem(input({ sourceTier: 1 })).credibilityAuthorityScore, { highAuthorityIndependent: 1, medium: 0, vendorFlagged: 0 });
  assert.equal(assessItem(input({ sourceTier: null })).credibilityAuthorityScore, null);
  assert.equal(extractDoiCandidate("see doi 10.1000/example-freight-decarb. for"), "10.1000/example-freight-decarb");
});

test("an OpenAlex DOI resolves into a source record scored for authority; an unresolved DOI is no record, never a guessed one", async () => {
  const work = { publication_date: "2020-01-01", cited_by_count: 40, fwci: 2, citation_normalized_percentile: { value: 0.93 }, is_retracted: false, authorships: [{ institutions: [{ display_name: "A University", type: "education" }] }] };
  const fetch = (async (u: string) => (u.includes("10.1000%2Fno") || u.endsWith("10.1000/no") ? new Response("", { status: 404 }) : new Response(JSON.stringify(work), { status: 200 }))) as never;
  const authorityOf = async (text: string) => (await parseDoc(researchAssessment, { text: JSON.stringify([input({ text })]) }, { deps: { ...makeDeps({ noDb: true }).deps, fetch }, now: () => NOWD })).rows[0]?.credibility_authority_score;
  const resolved = (await authorityOf("cites doi 10.1000/yes here")) as { medium?: number; highAuthorityIndependent?: number };
  assert.deepEqual([resolved.medium, resolved.highAuthorityIndependent], [1, 0], "a university with undisclosed funding is medium, not high-authority-independent");
  const tierOnly = await authorityOf("no doi");
  assert.deepEqual(await authorityOf("cites doi 10.1000/no here"), tierOnly, "an unresolved DOI changes nothing: no record, never a guessed one");
});

const ASSESS_ENV = { RESEARCH_ASSESSMENT_PRODUCER_ENABLED: "1" };
const futureInput = (text = "FuelEU compliance date applies. A demonstration pilot project.") => input({ text, forwardEvents: [ev("e1", "2027-06-01", "FuelEU phase-in")], entityId: "cl:instrument:aaaa" });
test("INV-249: a row is written only on change; the superseded row is flipped and its unscored signposts re-pointed; signpost ids are deterministic so a re-run writes none", async () => {
  const db = memoryDb({});
  const d = makeDeps({ db, env: ASSESS_ENV });
  const armed = { ...researchAssessment, enabled: true };
  const first = await runProducer(d.deps, { spec: armed, dry: false, text: JSON.stringify([futureInput()]) });
  assert.equal(first.outcome, "ok", first.notes.join("|"));
  assert.deepEqual([first.counts.written, first.counts.signposts_written], [1, 1]);
  const assessment = db.tables.research_assessments?.[0];
  assert.ok(assessment);
  assert.equal(db.tables.signposts?.[0]?.entity_id, entityId("signpost", "signpost:item-1:e1"));
  assert.equal(db.tables.signposts?.[0]?.assessment_id, assessment.id);
  assert.equal(db.tables.entities?.[0]?.kind, "signpost");
  // the view row now exists: an identical re-run writes nothing and creates no second signpost
  db.tables.research_assessments_current = [{ ...assessment }];
  const noChange = await runProducer(d.deps, { spec: armed, dry: false, text: JSON.stringify([futureInput()]) });
  assert.deepEqual([noChange.counts.unchanged, noChange.counts.written, noChange.counts.signposts_written, noChange.counts.signposts_existing], [1, 0, 0, 1]);
  assert.equal(db.tables.research_assessments?.length, 1);
  // a changed text moves the horizon: the old row is flipped, the successor supersedes it, the unscored signpost follows
  const changed = await runProducer(d.deps, { spec: armed, dry: false, text: JSON.stringify([futureInput("Hydrogen trucks. FuelEU compliance date. Commercially available and in commercial operation.")]) });
  assert.equal(changed.counts.written, 1);
  assert.equal(changed.counts.signposts_repointed, 1);
  const [old, successor] = db.tables.research_assessments ?? [];
  assert.equal(old?.is_current, false);
  assert.equal(successor?.supersedes, old?.id);
  assert.equal(db.tables.signposts?.[0]?.assessment_id, successor?.id);
  assert.equal(db.tables.signposts?.length, 1);
  assert.equal(hasChanged(null, {}), true);
  assert.equal(hasChanged(assessment, assessment), false);
});

test("INV-249: a failed insert restores the flipped row (never zero current rows), and a refused item (no horizon) still gets a row stating the refusal", async () => {
  const db = memoryDb({ research_assessments_current: [] }, { failures: [{ table: "research_assessments", op: "insert", message: "unique violation" }] });
  const armed = { ...researchAssessment, enabled: true };
  const d = makeDeps({ db, env: ASSESS_ENV });
  const failed = await runProducer(d.deps, { spec: armed, dry: false, text: JSON.stringify([input({ text: "nothing forecastable" })]) });
  assert.equal(failed.outcome, "failed");
  const ok = memoryDb({});
  const r = await runProducer(makeDeps({ db: ok, env: ASSESS_ENV }).deps, { spec: armed, dry: false, text: JSON.stringify([input({ text: "nothing forecastable" })]) });
  assert.equal(r.counts.written, 1);
  assert.equal(ok.tables.research_assessments?.[0]?.refusal_reason, "no_dated_basis");
  assert.equal(toRow(assessItem(input({ text: "x" }), { now: NOWD })).computed_by, "research-assessment-producer@1");
});

test("INV-249: a failed insert restores the flipped current row, so a failure never leaves an item with zero current assessments", async () => {
  const old = { id: "a-old", item_id: "item-1", is_current: true, technical_maturity_low: 1, status_token: "HYPOTHESIS", horizon_band: "FAR" };
  const db = memoryDb({ research_assessments: [{ ...old }], research_assessments_current: [{ ...old }] }, { failures: [{ table: "research_assessments", op: "insert", message: "unique violation" }] });
  const r = await runProducer(makeDeps({ db, env: ASSESS_ENV }).deps, { spec: { ...researchAssessment, enabled: true }, dry: false, text: JSON.stringify([futureInput()]) });
  assert.equal(r.outcome, "failed");
  assert.equal(db.tables.research_assessments?.[0]?.is_current, true);
});

test("the first live pass scores only verified research items with no current assessment, bounded by the limit, with the source tier and forward events", async () => {
  const db = memoryDb({
    intelligence_items: [
      { id: "i1", item_type: "research_finding", domain: 7, title: "T1", what_is_it: "w", is_archived: false, provenance_status: "verified", source_id: "s1", instrument_entity_id: null },
      { id: "i2", item_type: "research_finding", domain: 7, title: "T2", is_archived: false, provenance_status: "verified", source_id: "s1" },
      { id: "i3", item_type: "regulation", domain: 1, title: "T3", is_archived: false, provenance_status: "verified", source_id: "s1" },
      { id: "i4", item_type: "research_finding", domain: 7, title: "T4", is_archived: true, provenance_status: "verified", source_id: "s1" },
      { id: "i5", item_type: "research_finding", domain: 7, title: "T5", is_archived: false, provenance_status: "unverified", source_id: "s1" },
    ],
    research_assessments_current: [{ item_id: "i2" }],
    sources: [{ id: "s1", base_tier: 2 }],
    item_forward_events: [{ id: "e1", intelligence_item_id: "i1", event_date: "2027-01-01", event_kind: "x", obligation_text: "o" }],
  });
  const out = await fetchLiveCandidates(db.db);
  assert.deepEqual(out.map((c) => c.id), ["i1"]);
  assert.equal(out[0]?.sourceTier, 2);
  assert.equal(out[0]?.forwardEvents.length, 1);
  assert.equal((await fetchLiveCandidates(db.db, 0)).length, 1);
});

// ---- walker ----
const W = (url: string, title: string, over: object = {}) => ({ id: `https://openalex.org/W${title}`, title, doi: null, publication_date: "2026-09-10", primary_location: { landing_page_url: url }, ...over });
const walkerDeps = (db = makeWorld(), over: Partial<WalkerDeps> = {}) => {
  const { deps: md, rec } = mintDeps(db);
  const base = makeDeps({ noDb: true, env: { RESEARCH_WALKER_ENABLED: "1" } });
  const deps = { ...base.deps, sb: db.client, mint: { sb: md.sb, entities: md.entities, connect: md.connect, now: md.now }, ...over } as WalkerDeps;
  return { deps, rec, db };
};
test("walker: publisher placement by built-in rule, by committed host verdict, and the named residue; the residue is a note, never a rejection or a guessed tier; a work with no landing page or DOI is no candidate", async () => {
  const { deps } = walkerDeps(makeWorld(), { verdicts: new Map([["unplaced-example.test", { class: "academic", batch: "host-verdicts-001" }]]) as never });
  const noLanding = { primary_location: { landing_page_url: null }, doi: null };
  const doc = { topic: [W("https://eprints.soton.ac.uk/1", "By rule"), W("https://unplaced-example.test/p", "By verdict"), W("https://unlisted-journal.example/a/42", "Unlisted"), W("", "Doi only", { primary_location: { landing_page_url: null }, doi: "https://doi.org/10.1/x" }), W("", "Nowhere", noLanding)] };
  const out = await parseDoc(researchWalker, { text: JSON.stringify(doc) }, { deps });
  assert.deepEqual(out.rows.map((r) => [r.title, r.__host, r.item_type, r.domain, r.added_date]), [["By rule", "eprints.soton.ac.uk", "research_finding", 7, "2026-09-10"], ["By verdict", "unplaced-example.test", "research_finding", 7, "2026-09-10"]], "the placed publishers are mint seeds; the rest are not");
  assert.equal(typeof out.rows[0]?.__tier, "number");
  const notes = (out.warnings ?? []).join("|");
  assert.match(notes, /unlisted-journal\.example\/a\/42: residue: awaiting host verdict batch \(host unlisted-journal\.example\)/);
  assert.match(notes, /doi\.org\/10\.1\/x: residue: publisher host unresolved from DOI/);
  assert.doesNotMatch(notes, /Nowhere|rejected/, "no landing page and no DOI is not a candidate, and a residue is not a rejection");
  assert.equal(out.counts?.residue, 2);
  // a bounded pass: at most ten needs, by subject ref, so the pass is repeatable
  const searched = makeDeps({ noDb: true, routes: { "https://api.openalex.org/works": JSON.stringify({ results: [] }) } });
  const needs = Array.from({ length: 12 }, (_, i) => ({ subject_ref: `n${String(11 - i).padStart(2, "0")}`, need: `need ${11 - i}` }));
  await walkResearch({ ...searched.deps, mint: undefined } as never, { walk: { needs } }).catch(() => undefined);
  const asked = searched.calls.map((c) => decodeURIComponent(new URL(c.url).searchParams.get("search") ?? ""));
  assert.deepEqual(asked, Array.from({ length: 10 }, (_, i) => `need ${i}`), "the first ten needs by subject ref, in that order");
});

test("walker dry: placed publishers pass the mint chokepoint's gates dry, residue is named and not rejected, nothing is written or registered; a failed need search is a note", async () => {
  const { deps, db } = walkerDeps();
  const doc = { topic: [W("https://eprints.soton.ac.uk/rail", "Rail modal shift"), W("https://unlisted-journal.example/a/42", "Drayage cost review"), W("https://eprints.soton.ac.uk/rail", "Duplicate url")], needs: [{ subject_ref: "need-1", need: "freight", works: [W("https://uni.ac.uk/p", "For a need")], error: null }, { subject_ref: "need-2", need: "x", works: [], error: "boom" }], greyLit: [{ name: "International Energy Agency", url: "https://www.iea.org/reports/r1" }] };
  const r = await runProducer(deps, { spec: researchWalker, text: JSON.stringify(doc) });
  assert.equal(r.outcome, "ok", r.notes.join("|"));
  assert.deepEqual([r.counts.candidates, r.counts.would_mint, r.counts.residue, r.counts.rejected, r.counts.needs_searched], [3, 3, 1, 0, 2]);
  assert.match(r.notes.join("|"), /unlisted-journal\.example\/a\/42: residue: awaiting host verdict batch/);
  assert.match(r.notes.join("|"), /need need-2: search failed: boom/);
  assert.equal(db.writes("intelligence_items").length, 0);
  assert.equal(db.writes("sources").length, 0);
  const none = await walkResearch(deps, { walk: {} });
  assert.equal(none.counts.gap, 1);
});

test("walker: an item the chokepoint already holds is counted as held, never as a new mint, and nothing is written", async () => {
  const db = makeWorld({ items: [{ id: "held-1", title: "Rail modal shift study", source_url: "https://eprints.soton.ac.uk/rail", item_type: "research_finding", is_archived: false, source_id: null }] });
  const { deps } = walkerDeps(db);
  const r = await runProducer(deps, { spec: researchWalker, text: JSON.stringify({ topic: [W("https://eprints.soton.ac.uk/rail", "Rail modal shift study")] }) });
  assert.deepEqual([r.counts.already_held, r.counts.would_mint, r.counts.rejected], [1, 0, 0]);
  assert.equal(r.counts.parsed, 0);
});

test("walker apply (armed): a placed publisher is registered provisional at its placed tier, the item is minted through mintItem with that source, and a mint refusal is counted; a refused gate fetches nothing", async () => {
  const { deps, db, rec } = walkerDeps();
  const armed = { ...researchWalker, enabled: true };
  const doc = { topic: [W("https://eprints.soton.ac.uk/rail", "Rail modal shift study")] };
  const r = await runProducer(deps, { spec: armed, dry: false, text: JSON.stringify(doc) });
  assert.equal(r.outcome, "ok", r.notes.join("|"));
  assert.equal(r.counts.minted, 1);
  const item = db.rows("intelligence_items")[0];
  assert.deepEqual([item?.item_type, item?.domain, item?.source_url], ["research_finding", 7, "https://eprints.soton.ac.uk/rail"]);
  const src = db.rows("sources").find((s) => s.url === "https://eprints.soton.ac.uk/rail");
  assert.equal(src?.status, "provisional");
  assert.equal(item?.source_id, src?.id);
  assert.ok(rec.connects.some((c) => c.startsWith("connect:")), "rule 17: the chokepoint connects the mint in the same run");
  const closed = walkerDeps(makeWorld(), { env: {} });
  const refused = await runProducer(closed.deps, { spec: armed, dry: false, text: JSON.stringify(doc) });
  assert.match(refused.notes[0] as string, /kill switch/);
  assert.equal(closed.db.rows("intelligence_items").length, 0);
  const unarmed = await runProducer(walkerDeps().deps, { spec: researchWalker, dry: false, text: JSON.stringify(doc) });
  assert.match(unarmed.notes[0] as string, /ENABLED constant is false/);
});

// ---- themes ----
test("theme rules: the closed seven-theme vocabulary, a single best match classifies, a tie or no match stays unclassified (the honest band), never a forced pick", () => {
  assert.equal(THEME_VALUES.length, 7);
  assert.equal(classifyTheme("Sustainable aviation fuel feedstock supply and SAF price trajectory").theme, "fuels_saf");
  assert.equal(classifyTheme("EU ETS allowance prices and the CBAM carbon border mechanism").theme, "carbon_markets");
  assert.equal(classifyTheme("CSRD and ISSB S2 sustainability reporting").theme, "disclosure_regimes");
  assert.deepEqual(classifyTheme("A study of port congestion"), { theme: "unclassified", matched: [], reason: "no-match" });
  const tie = classifyTheme("hydrogen reefer");
  assert.equal(tie.theme, "unclassified");
  assert.equal(tie.reason, "tie");
});
