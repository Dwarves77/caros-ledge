// R2b I1/I6: the claim ledger's one writer. INV-R2b-1 (after a heal every FACT's source, tier and capture resolve to the capture that holds its span), INV-R2b-3 (a failure inside a ledger call leaves every
// touched table as it was), the tier-laundering attack on heal, rehome, the Gate A orphan and the section delete, and the archive of a section or an item that goes. The SQL itself is attacked by migration
// 0074's self-check on the real schema; here the application code that calls it runs against the same rules (tests/_support/ledger-rpcs.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyLedgerDiff, applyLedgerOps, eraseItem, reattributeClaim, reconcileSections, sourceForCapture, type AttributionCtx } from "@/core/grounding/ledger";
import { eraseQuarantined, rehomeQuarantined, sectionBrief } from "@/features/intake";
import { briefSentenceOf, NO_VERBATIM_SPAN, planOrphan, supportingSentence, type Bucket } from "@/features/mint/heal/ground";
import { healItem } from "@/features/mint";
import { extractSections } from "@/core/brief/sections";

import { attribution, installLedgerRpcs } from "../_support/ledger-rpcs.ts";
import { ITEM as INTAKE_ITEM, NOW, OFFICIAL_URL, SOURCE as INTAKE_SOURCE, CORROB, OTHER_URL, SPAN_REPORT, makeWorld as intakeWorld, marketSignalBody } from "../intake/fixtures.ts";
import { MemDb } from "../intake/memdb.ts";
import { CELEX_URL, makeDeps, makeWorld, SOURCE } from "../mint/world.ts";

// ---- the single writer: the source and tier come from the CAPTURE'S host, never the item's ----------------------------------------------------------------------------------------------------
const ctxOf = (by: Record<string, string>): AttributionCtx => ({ resolve: (url) => (by[new URL(url).hostname] ? { sourceId: by[new URL(url).hostname] as string } : null) });

test("reattributeClaim: the op takes the source is the one registered on the CAPTURE'S host; an unregistered host is registered and rated when the context may (rule 18), else the FACT stays unrated, and never borrows another source", async () => {
  const ctx = ctxOf({ "eur-lex.europa.eu": "src-law", "news.test": "src-news" });
  assert.deepEqual((await reattributeClaim({ id: "c1" }, { id: "cap-news", url: "https://news.test/a" }, "a span", ctx) as { row: Record<string, unknown> }).row, { source_span: "a span", search_result_id: "cap-news", source_id: "src-news" });
  assert.equal(await sourceForCapture("https://unknown.test/x", ctx), null, "an unregistered host leaves the FACT unrated, it is not given the item's source");
  const registering: AttributionCtx = { ...ctx, register: async (url) => ({ sourceId: new URL(url).hostname === "unknown.test" ? "src-new" : null }) };
  assert.equal(await sourceForCapture("https://unknown.test/x", registering), "src-new");
  assert.equal(await sourceForCapture("https://platform.test/x", registering), null, "a host that cannot be rated stays unrated");
  assert.equal(await sourceForCapture("https://news.test/a", { ...registering, register: async () => assert.fail("a registered host is never registered again") }), "src-news");
});

const ledgerWorld = () => {
  const db = new MemDb();
  installLedgerRpcs(db);
  db.seed("intelligence_items", [{ id: INTAKE_ITEM, title: "t", item_type: "regulation", provenance_status: "quarantined", is_archived: false }]);
  db.seed("sources", [{ id: INTAKE_SOURCE, url: "https://eur-lex.europa.eu/", base_tier: 1, status: "active" }, { id: CORROB, url: "https://example-news.test/", base_tier: 5, status: "active" }]);
  db.seed("agent_run_searches", [{ id: "cap-law", intelligence_item_id: INTAKE_ITEM, result_url: OFFICIAL_URL, result_content: `Article 2. ${SPAN_REPORT}`, result_index: 0 }, { id: "cap-news", intelligence_item_id: INTAKE_ITEM, result_url: OTHER_URL, result_content: `A paper says: ${SPAN_REPORT}`, result_index: 1 }]);
  db.seed("section_claim_provenance", [{ id: "c1", intelligence_item_id: INTAKE_ITEM, claim_text: "duty", claim_kind: "FACT", source_span: SPAN_REPORT, source_id: INTAKE_SOURCE, search_result_id: "cap-news", source_tier_at_grounding: 1 }]);
  return db;
};

test("reattributeClaim applied by the database: a FACT stood on a capture takes that capture's source and tier in one call with its archive row; the database refuses a source from another host and a span the capture lacks, and leaves the claim as it was", async () => {
  const db = ledgerWorld();
  const ctx = { resolve: (url: string) => ({ sourceId: new URL(url).hostname === "eur-lex.europa.eu" ? INTAKE_SOURCE : CORROB }) };
  const apply = async (span: string, via: AttributionCtx = ctx) => applyLedgerOps(db.client, INTAKE_ITEM, [await reattributeClaim({ id: "c1" }, { id: "cap-news", url: OTHER_URL }, span, via)], NOW.toISOString());
  assert.deepEqual(attribution(db, INTAKE_SOURCE, "cap-news", SPAN_REPORT), { tier: null, problem: "source_host_mismatch" }, "the laundering the old heal wrote: a news capture under the regulator's source");
  await apply(SPAN_REPORT);
  const c = db.rows("section_claim_provenance")[0] as Record<string, unknown>;
  assert.deepEqual([c.source_id, c.source_tier_at_grounding, c.search_result_id], [CORROB, 5, "cap-news"], "the news capture is rated as the news source, tier 5");
  assert.equal(db.rows("claim_versions").length, 1);
  assert.equal(db.rows("claim_versions")[0]?.source_tier_at_grounding, 1, "the archived state is the laundered one");
  await assert.rejects(apply("a sentence no capture holds"), /span_not_in_capture/);
  await assert.rejects(apply(SPAN_REPORT, { resolve: () => ({ sourceId: INTAKE_SOURCE }) }), /source_host_mismatch/, "the item's own source cannot be attached to a capture on another host");
  assert.equal(db.rows("claim_versions").length, 1, "the refused calls archived nothing");
  assert.equal((db.rows("section_claim_provenance")[0] as Record<string, unknown>).source_id, CORROB);
});

test("INV-R2b-3: an ops list is ALL OR NOTHING: a change, a section write and a brief write followed by a refused FACT leave every table as it was; an injected failure after the first write does the same", async () => {
  const db = ledgerWorld();
  db.seed("intelligence_item_sections", [{ id: "sec1", item_id: INTAKE_ITEM, section_key: "1", section_order: 1, content_md: "kept" }]);
  const snapshot = () => structuredClone(["section_claim_provenance", "claim_versions", "intelligence_item_sections", "intelligence_items"].map((t) => db.rows(t)));
  const before = snapshot();
  const good = { op: "claim", claim_id: "c1", row: { source_span: SPAN_REPORT, search_result_id: "cap-law", source_id: INTAKE_SOURCE } } as const;
  await assert.rejects(applyLedgerOps(db.client, INTAKE_ITEM, [good, { op: "section_content", id: "sec1", content_md: "changed" }, { op: "brief", full_brief: "new brief" }, { op: "claim", claim_id: null, row: { claim_text: "x", claim_kind: "FACT", source_span: "not in the capture", source_id: INTAKE_SOURCE, search_result_id: "cap-law" } }], NOW.toISOString()), /attribution refused: span_not_in_capture/);
  assert.deepEqual(snapshot(), before, "a refused list changed nothing");
  let archives = 0;
  db.failWhen = (c) => (c.table === "section_claim_provenance" && c.op === "update" && (archives += 1) >= 1 ? "injected failure after the archive" : null);
  await assert.rejects(applyLedgerOps(db.client, INTAKE_ITEM, [good, { op: "brief", full_brief: "new brief" }], NOW.toISOString()), /injected failure after the archive/);
  assert.deepEqual(snapshot(), before, "an injected failure after the first write left every table byte-identical");
  assert.equal(db.rows("claim_versions").length, 0, "the archive row of the failed call is gone with it");
  db.failWhen = null;
  const done = await applyLedgerOps(db.client, INTAKE_ITEM, [good, { op: "brief", full_brief: "new brief" }], NOW.toISOString());
  assert.deepEqual(done, { claims: 1, removed: 0, sections: 0 });
  assert.equal(db.rows("claim_versions").length, 1);
});

// ---- heal: INV-R2b-1 and the whole-pass transaction -------------------------------------------------------------------------------------------------------------------------------------------
const ITEM = "a0000000-0000-4000-8000-0000000000aa";
const NEWS = "b0000000-0000-4000-8000-0000000000e1";
const NEWS_URL = "https://news.example/story";
const NEWS_TEXT = "A trade paper reports that operators shall pay a fee of EUR 75 per tonne from 2027, according to the draft text it has seen.";
const SLOT_GAPS = [["binding_position", "[binding_position] No verbatim statement."], ["due_date", "[due_date] No verbatim statement."]];
function launderedWorld(spans: string[] = ["a fee of EUR 75 per tonne"]) {
  const db = makeWorld({ census: [], storedText: null });
  db.seed("sources", [{ id: NEWS, name: "Trade news", url: NEWS_URL, base_tier: 6, tier_override: null, status: "active", institution_id: null, category: "news" }]);
  db.seed("intelligence_items", [{ id: ITEM, item_type: "regulation", priority: "HIGH", source_id: SOURCE, source_url: CELEX_URL, canonical_instrument_key: "32023R9999", full_brief: "Catalogue record.", is_archived: false, provenance_status: "quarantined", item_grade: "record", archive_reason: null }]);
  db.seed("agent_run_searches", [{ id: "cap-news", intelligence_item_id: ITEM, result_url: NEWS_URL, result_content: NEWS_TEXT, result_index: 0, search_query: "x" }]);
  db.seed("intelligence_item_sections", [{ id: "sec1", item_id: ITEM, section_key: "record_facts", section_order: 2, content_md: "" }]);
  db.seed("section_claim_provenance", [
    ...SLOT_GAPS.map(([, text]) => ({ intelligence_item_id: ITEM, section_row_id: "sec1", claim_kind: "GAP", claim_text: text, source_span: null, source_id: null, search_result_id: null, source_tier_at_grounding: null })),
    ...spans.map((span, i) => ({ id: `cl${i + 1}`, intelligence_item_id: ITEM, section_row_id: "sec1", claim_kind: "FACT", claim_text: `fee claim ${i + 1}`, source_span: span, source_id: SOURCE, search_result_id: "cap-news", source_tier_at_grounding: 1 })),
  ]);
  return db;
}
const heal = (db: MemDb, input: Record<string, unknown> = {}) => {
  const d = makeDeps(db).deps;
  return healItem({ sb: d.sb, now: () => NOW, fetch: d.fetch }, { itemId: ITEM, dry: false, ...input });
};

test("INV-R2b-1 / D:1,2: a FACT stamped with the item's regulator source and tier but standing on a NEWS capture is re-attributed to the news source at the news tier, with its capture; afterwards no claim of the item fails the attribution check; the prior state is archived", async () => {
  const db = launderedWorld();
  assert.equal(db.rpcs.ledger_attribution_violations?.({ p_item_id: ITEM }, db).data instanceof Array && (db.rpcs.ledger_attribution_violations?.({ p_item_id: ITEM }, db).data as unknown[]).length, 1, "the planted laundering is detected before the heal");
  const r = await heal(db);
  assert.equal(r.counts.attribution_repaired, 1, r.notes.join("; "));
  const c = db.rows("section_claim_provenance").find((x) => x.id === "cl1") as Record<string, unknown>;
  assert.deepEqual([c.source_id, c.source_tier_at_grounding, c.search_result_id], [NEWS, 6, "cap-news"], "the tier is the news source's (6), not the regulator's (1)");
  assert.deepEqual(db.rpcs.ledger_attribution_violations?.({ p_item_id: ITEM }, db).data, [], "INV-R2b-1: every claim resolves to the capture that holds its span");
  const v = db.rows("claim_versions").find((x) => x.current_claim_id === "cl1") as Record<string, unknown>;
  assert.deepEqual([v.source_id, v.source_tier_at_grounding, v.note], [SOURCE, 1, "heal:attribution"]);
  assert.equal(r.counts.attribution_violations, undefined);
});

test("INV-R2b-3 on heal: the whole pass is ONE transaction: a refusal on the second change leaves the first change, the archive rows, the sections and the brief exactly as they were, and the item is reported failed with the rule", async () => {
  const db = launderedWorld(["a fee of EUR 75 per tonne", "operators shall pay a fee"]);
  const tables = ["section_claim_provenance", "claim_versions", "intelligence_item_sections"];
  const before = structuredClone(tables.map((t) => db.rows(t)));
  let n = 0;
  db.failWhen = (c) => (c.table === "claim_versions" && c.op === "insert" && (n += 1) === 2 ? "injected: the second archive write failed" : null);
  const r = await heal(db);
  assert.equal(r.outcome, "failed");
  assert.match(r.notes.at(-1) ?? "", /injected: the second archive write failed/);
  assert.deepEqual(tables.map((t) => db.rows(t)), before, "no partial heal: both claims, the archive and the sections are byte-identical");
});

test("D:4: a Gate A orphan is grounded by a SENTENCE of the capture that says what the brief says, never by the bare figure or a generated sentence; an unrelated '10%' is withheld as no_verbatim_span", () => {
  const brief = "Fines rise by 10% for operators who file late. Reports are annual.";
  const sentence = briefSentenceOf("10%", brief);
  assert.equal(sentence, "Fines rise by 10% for operators who file late.");
  const bucket = (text: string): Bucket => ({ id: "b1", result_url: CELEX_URL, result_content: text, source_id: SOURCE, bucket: "own_canonical" });
  const unrelated = planOrphan({ token: "10%", class: "figure" }, sentence, [bucket("The tax on interest income is 10% of the amount received. Operators file elsewhere.")]);
  assert.deepEqual(unrelated, { found: false, reason: NO_VERBATIM_SPAN }, "a '10%' in an unrelated paragraph backs nothing");
  assert.equal(supportingSentence("10%", sentence as string, bucket("The tax on interest income is 10% of the amount received.")), null);
  const related = planOrphan({ token: "10%", class: "figure" }, sentence, [bucket("Preamble. Late filers face fines that rise by 10% for operators. End.")]);
  assert.equal(related.found, true);
  assert.equal(related.found ? related.span : "", "Late filers face fines that rise by 10% for operators.", "the span is the capture's own sentence, a byte-exact slice");
  assert.equal(planOrphan({ token: "10%", class: "figure" }, null, [bucket("Fines rise by 10% for late operators.")]).found, false, "no sentence in the brief states it: withheld");
});

// ---- rehome (D:3) ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
test("D:3: rehome stands the FACT on the FLOOR capture: source, tier AND capture id move together (the old writer set the floor tier and left the span on the below-floor capture), the prior state is archived, and one refused claim re-homes none", async () => {
  const w = intakeWorld({ itemType: "regulation" });
  w.db.afterWrite = (c, db) => void (c.table === "intelligence_items" && c.op === "update" && db.rpcs.validate_item_provenance?.({ p_item_id: INTAKE_ITEM }, db));
  const law = w.db.rows("agent_run_searches").find((r) => r.result_url === OFFICIAL_URL) as Record<string, unknown>;
  const news = w.db.rows("agent_run_searches").find((r) => r.result_url === OTHER_URL) as Record<string, unknown>;
  news.result_content = `${String(news.result_content)} A paper repeats: ${SPAN_REPORT}`;
  w.db.seed("section_claim_provenance", [{ id: "k1", intelligence_item_id: INTAKE_ITEM, claim_kind: "FACT", claim_text: "[report] duty", source_span: SPAN_REPORT, source_id: CORROB, search_result_id: news.id, source_tier_at_grounding: 5 }]);
  const applied = await rehomeQuarantined({ sb: w.deps.sb, sources: w.deps.sources, now: () => NOW }, { apply: true });
  assert.equal(applied.decisions[0]?.outcome, "VERIFIED-FREE");
  const c = w.db.rows("section_claim_provenance")[0] as Record<string, unknown>;
  assert.deepEqual([c.source_id, c.source_tier_at_grounding, c.search_result_id], [INTAKE_SOURCE, 1, law.id], "source, tier and capture are the floor capture's, together");
  assert.deepEqual(w.db.rpcs.ledger_attribution_violations?.({ p_item_id: INTAKE_ITEM }, w.db).data, []);
  const v = w.db.rows("claim_versions")[0] as Record<string, unknown>;
  assert.deepEqual([v.source_id, v.source_tier_at_grounding, v.search_result_id], [CORROB, 5, news.id], "the below-floor state is archived first");
});

// ---- the section delete and the erase archive what they remove (D:21, D:144) -------------------------------------------------------------------------------------------------------------------
test("D:21: sectionBrief on an unverified item archives the claims of a vanished section to claim_versions before the section goes; surviving sections keep their ids and their claims", async () => {
  const w = intakeWorld({ itemType: "market_signal" });
  w.db.rows("intelligence_items")[0]!.full_brief = marketSignalBody();
  const keys = extractSections(marketSignalBody(), "market_signal").map((s) => s.section_key);
  w.db.seed("intelligence_item_sections", [...keys.map((k, i) => ({ id: `sec-${k}`, item_id: INTAKE_ITEM, section_key: k, section_order: i + 1, content_md: "old" })), { id: "sec-gone", item_id: INTAKE_ITEM, section_key: "legacy_9", section_order: 99, content_md: "old section" }]);
  w.db.seed("section_claim_provenance", [{ id: "kept", intelligence_item_id: INTAKE_ITEM, section_row_id: "sec-1", claim_kind: "ANALYSIS", claim_text: "stays" }, { id: "doomed", intelligence_item_id: INTAKE_ITEM, section_row_id: "sec-gone", claim_kind: "ANALYSIS", claim_text: "goes with its section" }]);
  const r = await sectionBrief({ sb: w.deps.sb, sources: w.deps.sources, recorder: w.deps.recorder }, INTAKE_ITEM);
  assert.equal(r.outcome, "ok", r.notes.join("; "));
  assert.equal(w.db.rows("intelligence_item_sections").some((s) => s.id === "sec-gone"), false);
  assert.deepEqual(w.db.rows("section_claim_provenance").map((c) => c.id), ["kept"]);
  const v = w.db.rows("claim_versions")[0] as Record<string, unknown>;
  assert.deepEqual([v.current_claim_id, v.claim_text, v.supersede_reason, (v.inaccuracy_proof as Record<string, unknown>).section_key], ["doomed", "goes with its section", "orphaned_no_prose_referent", "legacy_9"]);
  assert.equal(r.counts.claims_archived, 1);
  assert.equal(w.db.rows("intelligence_item_sections").find((s) => s.id === "sec-1")?.content_md !== "old", true, "a surviving section is updated in place under its own id");
});

test("DRAIN-FIX-2 R2: sectionBrief re-sections a VERIFIED item whose stored sections are not cut from its brief (claims archived first); a verified item whose sections derive from the brief is left alone", async () => {
  const w = intakeWorld({ itemType: "market_signal" });
  const row = w.db.rows("intelligence_items")[0]!;
  row.full_brief = marketSignalBody();
  row.provenance_status = "verified";
  const deps = { sb: w.deps.sb, sources: w.deps.sources, recorder: w.deps.recorder };
  const cut = extractSections(marketSignalBody(), "market_signal");
  w.db.seed("intelligence_item_sections", cut.map((s, i) => ({ id: `sec-${s.section_key}`, item_id: INTAKE_ITEM, section_key: s.section_key, section_order: i + 1, content_md: "text of an older brief" })));
  const stale = await sectionBrief(deps, INTAKE_ITEM);
  assert.equal(stale.counts.sections, cut.length, stale.notes.join("; "));
  assert.equal(w.db.rows("intelligence_item_sections").some((s) => s.content_md === "text of an older brief"), false);
  const same = await sectionBrief(deps, INTAKE_ITEM);
  assert.deepEqual([same.counts.sections, same.notes.some((n) => /already verified/.test(n))], [0, true], "sections now derive from the brief: left alone");
});

test("D:144: erase writes the tombstone, archives every claim of the item to claim_versions and deletes the item in ONE call; a failure at any step leaves the item, its claims and the ledger untouched", async () => {
  const mk = () => {
    const db = new MemDb();
    installLedgerRpcs(db);
    db.seed("intelligence_items", [{ id: "e1", legacy_id: "L-1", title: "dup", is_archived: true, archive_reason: "duplicate", source_id: INTAKE_SOURCE, full_brief: "x", canonical_instrument_key: "K1", source_url: "https://a.test/" }]);
    db.seed("sources", [{ id: INTAKE_SOURCE, status: "active" }]);
    db.seed("corpus_census", [{ intelligence_item_id: "e1", haiku_verdict: "archive_correct" }]);
    db.seed("section_claim_provenance", [{ id: "q1", intelligence_item_id: "e1", claim_kind: "ANALYSIS", claim_text: "one" }, { id: "q2", intelligence_item_id: "e1", claim_kind: "ANALYSIS", claim_text: "two" }]);
    db.rpcs.acquire_mutation_lease = () => ({ data: [{ acquired: true, cur_holder: "h" }] });
    db.rpcs.release_mutation_lease = () => ({ data: [{ released: true }] });
    return db;
  };
  const bad = mk();
  const before = structuredClone(["intelligence_items", "section_claim_provenance", "claim_versions", "disposition_ledger"].map((t) => bad.rows(t)));
  bad.failWhen = (c) => (c.table === "intelligence_items" && c.op === "delete" ? "injected: the delete failed" : null);
  const failed = await eraseQuarantined({ sb: bad.client }, { keys: ["L-1"], disposition: "tombstone_delete_duplicate", holder: "h", apply: true });
  assert.equal(failed.outcomes[0]?.outcome, "failed");
  assert.deepEqual(["intelligence_items", "section_claim_provenance", "claim_versions", "disposition_ledger"].map((t) => bad.rows(t)), before, "no tombstone, no archive row, the item stays");
  const db = mk();
  const done = await eraseQuarantined({ sb: db.client }, { keys: ["L-1"], disposition: "tombstone_delete_duplicate", holder: "h", apply: true });
  assert.equal(done.outcomes[0]?.outcome, "deleted", done.notes.join("; "));
  assert.equal(db.rows("intelligence_items").length, 0);
  assert.deepEqual(db.rows("claim_versions").map((v) => v.current_claim_id).sort(), ["q1", "q2"], "every claim is archived before it goes");
  assert.equal(db.rows("disposition_ledger")[0]?.item_key, "L-1");
});

test("reconcileSections and eraseItem are the ledger module's doors: the claims of a vanished section and of an erased item are archived by the same call that removes them, and a refusal changes nothing", async () => {
  const db = ledgerWorld();
  db.seed("intelligence_item_sections", [{ id: "s-keep", item_id: INTAKE_ITEM, section_key: "1", section_order: 1, content_md: "old" }, { id: "s-gone", item_id: INTAKE_ITEM, section_key: "2", section_order: 2, content_md: "gone" }]);
  db.seed("section_claim_provenance", [{ id: "k-gone", intelligence_item_id: INTAKE_ITEM, section_row_id: "s-gone", claim_kind: "ANALYSIS", claim_text: "goes" }]);
  await assert.rejects(reconcileSections(db.client, INTAKE_ITEM, [], NOW.toISOString()), /non-empty sections array/);
  const r = await reconcileSections(db.client, INTAKE_ITEM, [{ section_key: "1", section_order: 1, content_md: "new", is_conditional: false }], NOW.toISOString());
  assert.deepEqual(r, { removed: 1, claims_archived: 1, updated: 1, inserted: 0 });
  assert.deepEqual(db.rows("claim_versions").map((v) => v.current_claim_id), ["k-gone"]);
  await assert.rejects(eraseItem(db.client, "missing", { disposition: "d", mergedInto: null, holder: "h" }), /not found/);
  const done = await eraseItem(db.client, INTAKE_ITEM, { disposition: "tombstone_delete_duplicate", mergedInto: null, holder: "h" });
  assert.equal(done.claims_archived, 1, "the one claim that was left");
  assert.equal(db.rows("intelligence_items").length, 0);
  assert.equal(db.rows("disposition_ledger")[0]?.disposition_by, "h");
});

test("ENGINE-FIX-2: reconciling an item whose vanishing section's claim is referenced by a forward event succeeds; the event follows an identical surviving claim, else keeps its quote on its capture", async () => {
  const db = ledgerWorld();
  db.seed("intelligence_item_sections", [{ id: "s-keep", item_id: INTAKE_ITEM, section_key: "1", section_order: 1, content_md: "old" }, { id: "s-gone", item_id: INTAKE_ITEM, section_key: "2", section_order: 2, content_md: "gone" }]);
  db.seed("section_claim_provenance", [
    { id: "k-twin", intelligence_item_id: INTAKE_ITEM, section_row_id: "s-keep", claim_kind: "FACT", claim_text: "duty by 2027", source_span: "by 2027", search_result_id: "cap-law" },
    { id: "k-gone", intelligence_item_id: INTAKE_ITEM, section_row_id: "s-gone", claim_kind: "FACT", claim_text: "duty by 2027", source_span: "by 2027", search_result_id: "cap-law" },
    { id: "k-solo", intelligence_item_id: INTAKE_ITEM, section_row_id: "s-gone", claim_kind: "FACT", claim_text: "report by 2030", source_span: "by 2030", search_result_id: "cap-law" },
  ]);
  const ev = (id: string, claim: string, span: string) => ({ id, intelligence_item_id: INTAKE_ITEM, event_date: "2027-01-01", date_precision: "year", event_kind: "target", obligation_text: span, source_kind: "claim", source_claim_id: claim, source_section_id: null, source_capture_id: null, source_span: span, confidence: "high" });
  db.seed("item_forward_events", [ev("e-twin", "k-gone", "by 2027"), ev("e-solo", "k-solo", "by 2030")]);
  const r = await reconcileSections(db.client, INTAKE_ITEM, [{ section_key: "1", section_order: 1, content_md: "new", is_conditional: false }], NOW.toISOString());
  assert.equal(r.removed, 1);
  const rows = Object.fromEntries(db.rows("item_forward_events").map((e) => [e.id, e]));
  assert.deepEqual([rows["e-twin"]?.source_claim_id, rows["e-twin"]?.source_kind, rows["e-twin"]?.confidence], ["k-twin", "claim", "high"], "re-pointed to the claim of the same text and span");
  assert.deepEqual([rows["e-solo"]?.source_claim_id, rows["e-solo"]?.source_kind, rows["e-solo"]?.source_capture_id, rows["e-solo"]?.confidence, rows["e-solo"]?.source_span], [null, "capture", "cap-law", "medium", "by 2030"], "no twin: the quote stays, on its capture");
});

test("ENGINE-FIX-2 Q5: replacing a ledger removes a claim a forward event is sourced from in a SURVIVING section; the event moves to its capture and keeps its quote", async () => {
  const db = ledgerWorld();
  db.seed("intelligence_item_sections", [{ id: "s-keep", item_id: INTAKE_ITEM, section_key: "1", section_order: 1, content_md: "old" }]);
  const old = { id: "k-old", intelligence_item_id: INTAKE_ITEM, section_row_id: "s-keep", claim_kind: "FACT", claim_text: "report by 2030", source_span: "by 2030", source_id: null, search_result_id: "cap-law", source_tier_at_grounding: null };
  db.seed("section_claim_provenance", [old]);
  db.seed("item_forward_events", [{ id: "e1", intelligence_item_id: INTAKE_ITEM, event_date: "2030-01-01", date_precision: "year", event_kind: "target", obligation_text: "by 2030", source_kind: "claim", source_claim_id: "k-old", source_section_id: null, source_capture_id: null, source_span: "by 2030", confidence: "high" }]);
  const r = await applyLedgerDiff(db.client, INTAKE_ITEM, { add: [], change: [], unchanged: [], notReproduced: [old] }, { nowIso: NOW.toISOString(), replaceLedger: true });
  assert.equal(r.applied.failed, 0, r.notes.join("; "));
  assert.equal(db.rows("section_claim_provenance").some((c) => c.id === "k-old"), false, "the old claim is gone");
  const e = db.rows("item_forward_events")[0];
  assert.deepEqual([e?.source_claim_id, e?.source_kind, e?.source_capture_id, e?.source_span], [null, "capture", "cap-law", "by 2030"]);
});
