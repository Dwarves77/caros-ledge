// The provenance healer: INV-298 (a value-preserving numeric fold, re-kind never rewrite), the position-preserving normaliser, floors and buckets, source-and-rate for an orphan
// figure (rule 18), the opt-in honest strip, and the re-derive. Every read and write is checked, and dry mode writes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";

import { scanGateA } from "@/core/grounding";
import { classTierForHost } from "@/core/sources";
import { healItem, healQuarantined, rederiveStale } from "@/features/mint";
import { buildBuckets, buildSourcesIndex, claimNeedsResource, foldRun, locateSpan, planGrounding, planResource, type Capture, type HealClaim } from "@/features/mint/heal/ground";
import { planBriefHonest, stripClause } from "@/features/mint/heal/brief-honest";
import { planReclassify, planRelabelFromFullBrief, planRelabelModal, planRelabelParagraph } from "@/features/mint/heal/label";

import { CELEX_URL, SOURCE, makeDeps, makeWorld, type WorldDb } from "./world.ts";

const cap = (text: string, id = "cap1"): Capture => ({ id, result_url: CELEX_URL, result_content: text });
const claim = (over: Partial<HealClaim>): HealClaim => ({ id: "c1", claim_kind: "FACT", claim_text: "t", source_span: null, source_id: null, search_result_id: null, section_row_id: null, ...over });

test("INV-298: the numeric fold is by VALUE: thousands groups fold, a decimal comma folds to a point, and an ambiguous single separator never folds", () => {
  const f = (s: string) => foldRun(s).text;
  assert.deepEqual(["1 200 000", "1,200,000", "1.200.000", "1 200"].map(f), ["1200000", "1200000", "1200000", "1200"]);
  assert.deepEqual(["35,5", "35.5", "0,75"].map(f), ["35.5", "35.5", "0.75"]);
  assert.deepEqual(["1.234,56", "1,234.56"].map(f), ["1234.56", "1234.56"], "a thousands group then a decimal");
  assert.equal(f("12.345"), "12.345", "one point and three digits: decimal or thousands, so it stays literal");
  assert.equal(f("12,345"), "12,345");
  assert.notEqual(f("12.345"), f("12,345"), "the two never fold onto one value");
  assert.equal(f("5 12"), "5 12", "a space before a non-thousands group is two numbers");
  const r = foldRun("1,200,000");
  assert.equal(r.text.length, r.offs.length);
});

test("INV-298: a tolerant match never changes the figure: 12.345 does not ground on 12,345, 345 does not ground inside 12,345, 12 does not ground inside 12.5", () => {
  assert.equal(locateSpan("12.345", cap("The total is 12,345 tonnes in the period.")), null);
  assert.equal(locateSpan("345", cap("The total is 12,345 tonnes in the period.")), null);
  assert.equal(locateSpan("12", cap("The ratio is 12.5 percent of the fleet.")), null);
  assert.equal(locateSpan("12,5", cap("The ratio is 12.5 percent of the fleet."))?.span, "12.5", "a decimal comma and a decimal point are one value");
  assert.equal(locateSpan("12.345", cap("The total is 12.345 tonnes in the period."))?.method, "exact");
});

test("the numeric tier finds the same value in another surface form and returns a byte-exact slice of the capture (ADR-016)", () => {
  const text = "A fine of EUR 1 200 000 applies, and emissions fall by 35,5 % by 2030, measured in gCO₂ per tkm.";
  for (const [needle, expected] of [["€1,200,000", "EUR 1 200 000"], ["35.5%", "35,5 %"], ["gCO2", "gCO₂"]] as const) {
    const found = locateSpan(needle, cap(text));
    assert.equal(found?.method, "numeric_tolerant", needle);
    assert.equal(found?.span, expected, needle);
    assert.ok(text.includes(found?.span ?? "\u0000"), "the span is verbatim in the capture");
  }
});

test("the structural tier decodes entities, drops soft hyphens, collapses whitespace and folds curly quotes, and still returns the ORIGINAL slice", () => {
  const text = "Operators&nbsp;shall  report the ‘verified’ emissions­ annually.";
  const f = locateSpan("Operators shall report the 'verified' emissions annually.", cap(text));
  assert.equal(f?.method, "normalized");
  assert.ok(text.includes(f?.span ?? "\u0000"), "verbatim in the capture");
  assert.equal(locateSpan("OPERATORS SHALL REPORT THE 'VERIFIED' EMISSIONS ANNUALLY.", cap(text))?.method, "normalized_ci");
  assert.equal(locateSpan("nothing like this", cap(text)), null);
});

test("planGrounding: already grounded only against the claim's OWN attributed capture; healed by re-pointing (claim text untouched); ungrounded otherwise", () => {
  const caps = [cap("Alpha beta gamma delta.", "a"), cap("Epsilon zeta eta theta iota.", "b")];
  assert.deepEqual(planGrounding(claim({ source_span: "beta gamma", search_result_id: "a" }), caps), { outcome: "already_grounded" });
  assert.deepEqual(planGrounding(claim({ source_span: "zeta eta", search_result_id: "a" }), caps), { outcome: "healed", newSpan: "zeta eta", method: "exact", searchId: "b" });
  assert.deepEqual(planGrounding(claim({ source_span: null, claim_text: "eta theta" }), caps), { outcome: "healed", newSpan: "eta theta", method: "claim_text_exact", searchId: "b" });
  assert.deepEqual(planGrounding(claim({ source_span: "nothing here", claim_text: "or here" }), caps), { outcome: "ungrounded_after_capture" });
  assert.deepEqual(planGrounding(claim({ claim_kind: "GAP" }), caps), { outcome: "not_applicable" });
});

test("floors and buckets: a below-floor FACT needs a better source; the own-canonical, tier-qualifying and corpus buckets are searched in that order", () => {
  const idx = buildSourcesIndex([{ id: "s1", url: CELEX_URL, base_tier: 1, institution_id: "i1" }, { id: "s2", url: "https://blog.example/post", base_tier: 5, institution_id: null }, { id: "s3", url: "https://agency.example/rule", base_tier: 2, institution_id: null }]);
  const item = { item_type: "regulation", priority: "MODERATE", source_id: "s1", source_url: CELEX_URL };
  assert.equal(claimNeedsResource(claim({ source_id: null }), item, idx), true, "no source");
  assert.equal(claimNeedsResource(claim({ source_id: "s2" }), item, idx), true, "tier 5 above the regulation floor of 2");
  assert.equal(claimNeedsResource(claim({ source_id: "s3" }), item, idx), false);
  assert.equal(claimNeedsResource(claim({ source_id: "s2" }), { ...item, item_type: "market_signal" }, idx), false, "a floor-exempt type is never re-sourced");
  const std = { ...item, item_type: "standard" };
  const idx2 = buildSourcesIndex([{ id: "s1", url: CELEX_URL, base_tier: 1, institution_id: "i1" }, { id: "s4", url: "https://own.example/std", base_tier: 4, institution_id: "i1" }]);
  assert.equal(claimNeedsResource(claim({ source_id: "s4" }), std, idx2), false, "a standard's own authoring body grounds at tier 4");
  const captures: Capture[] = [cap("own text one", "own"), { id: "t", result_url: "https://agency.example/rule", result_content: "tier text" }, { id: "b", result_url: "https://blog.example/post", result_content: "blog text" }];
  const buckets = buildBuckets(item, captures, idx, 2, [cap("corpus text", "corp")], 1);
  assert.deepEqual(buckets.map((b) => [b.id, b.bucket]), [["own", "own_canonical"], ["t", "tier_qualifying"], ["corp", "corpus_pool"]]);
  assert.deepEqual(planResource(claim({ source_span: "tier text" }), buckets), { outcome: "resourced", newSpan: "tier text", method: "exact", searchId: "t", sourceId: "s3", bucket: "tier_qualifying" });
  assert.equal(planResource(claim({ source_span: "blog text" }), buckets).outcome, "unresourced", "a below-floor capture is never a bucket");
  assert.deepEqual(buildBuckets(item, captures, idx, 2, [cap("corpus text", "corp")], 5).map((b) => b.bucket), ["own_canonical", "tier_qualifying"], "the corpus pool needs the item's own source at the floor");
});

test("re-kind, never rewrite (ruling 4): a required-slot FACT becomes the slot's GAP, a findable claim becomes ANALYSIS in place or in the section that holds it, and the rest is refused", () => {
  const sections = [{ id: "s1", content_md: "Operators must file within 30 days of the notice." }, { id: "s2", content_md: "Another paragraph about vessels." }];
  const slot = planReclassify(claim({ claim_text: "[binding_position] The captured source states, verbatim: «x»" }), sections, ["binding_position"], CELEX_URL);
  assert.equal(slot.kind, "gap");
  assert.match(slot.kind === "gap" ? slot.claim_text : "", /^\[binding_position\] No verbatim/);
  assert.deepEqual(planReclassify(claim({ claim_text: "must file within 30 days", section_row_id: "s1" }), sections, [], null), { kind: "analysis", sectionId: "s1", moved: false });
  assert.deepEqual(planReclassify(claim({ claim_text: "about vessels", section_row_id: "s1" }), sections, [], null), { kind: "analysis", sectionId: "s2", moved: true });
  assert.deepEqual(planReclassify(claim({ claim_text: "a sentence in no section" }), sections, [], null), { kind: "refused", reason: "claim_text_not_found_verbatim_in_any_section" });
});

test("relabelling only prefixes the analysis label: the paragraph, the full-brief branch and the unlabelled modal assertion", () => {
  const md = "First paragraph.\n\nOperators must file within 30 days.\n\nLast.";
  const p = planRelabelParagraph(md, "must file within 30 days");
  assert.equal(p?.after, "*Analytical inference:* Operators must file within 30 days.");
  assert.equal(p?.content_md, "First paragraph.\n\n*Analytical inference:* Operators must file within 30 days.\n\nLast.");
  assert.equal(planRelabelParagraph("*Analytical inference:* Operators must file within 30 days.", "must file"), null, "already labelled");
  assert.equal(planRelabelFromFullBrief({ id: "s", content_md: "Other." }, "A claim in the brief", "Intro. A claim in the brief. End.")?.content_md, "Other.\n\n*Analytical inference:* A claim in the brief");
  assert.equal(planRelabelFromFullBrief({ id: "s", content_md: "A claim in the brief" }, "A claim in the brief", "x"), null);
  assert.match(planRelabelModal("Quiet.\n\nThe operator must report.")?.content_md ?? "", /\*Analytical inference:\* The operator must report\./);
  assert.equal(planRelabelModal("The operator must report. *Legal Confirmation Required:*"), null);
});

test("the honest strip removes the sentence, or the one isolable middle clause, and is ACCEPTED only when Gate A then finds no orphan", () => {
  assert.deepEqual(stripClause("Fines are EUR 50 000, due 1 January 2027, and apply to vessels.", "1 January 2027"), { rewritten: "Fines are EUR 50 000, and apply to vessels.", removed: "due 1 January 2027" });
  assert.equal(stripClause("Fines are EUR 50 000, due 1 January 2027, and apply to vessels.", "EUR 50 000"), null, "the first clause is never guessed at");
  assert.equal(stripClause("Fines are EUR 50 000 and apply.", "EUR 50"), null);
  const single = "The regime applies to vessels. The penalty is EUR 50 000 per breach. Reports are annual.";
  const accepted = planBriefHonest(single, ["EUR 50"], []);
  assert.equal(accepted.outcome, "accepted");
  assert.equal(accepted.outcome === "accepted" ? accepted.newFullBrief : "", "The regime applies to vessels. Reports are annual.");
  assert.equal(accepted.outcome === "accepted" ? accepted.previous : "", single);
  const two = "Fines are EUR 50 000, due 1 January 2027, and apply to vessels.";
  const rejected = planBriefHonest(two, ["EUR 50", "1 January 2027"], []);
  assert.equal(rejected.outcome, "rejected", "the figure could not be stripped, so Gate A would still find an orphan");
  assert.equal(scanGateA(two, []).orphan_count, 2);
  assert.equal(planBriefHonest("Nothing to strip.", ["EUR 5"], []).outcome, "no_op");
});

// ---- the healer end to end --------------------------------------------------------------------------------------------------------------------------------------------------
const ITEM = "a0000000-0000-4000-8000-0000000000aa";
const CAPTURE = "Regulation (EU) 2023/9999 on sustainable freight operations. Operators of the 'CBAM' scheme pay EUR 50 000 per breach. This Regulation shall enter into force on 1 January 2027 and shall be binding in its entirety. Operators shall report verified annual emissions before 30 April of each year.";
function healWorld(o: { brief?: string; claims?: Record<string, unknown>[]; sections?: Record<string, unknown>[]; status?: string; captureText?: string | null } = {}) {
  const db = makeWorld({ census: [], storedText: null });
  db.seed("intelligence_items", [{ id: ITEM, item_type: "regulation", priority: "HIGH", source_id: SOURCE, source_url: CELEX_URL, canonical_instrument_key: "32023R9999", full_brief: o.brief ?? "Catalogue record.", is_archived: false, provenance_status: o.status ?? "quarantined", item_grade: "record", archive_reason: null }]);
  if (o.captureText !== null) db.seed("agent_run_searches", [{ id: "cap1", intelligence_item_id: ITEM, result_url: CELEX_URL, result_content: o.captureText ?? CAPTURE, result_index: 0, search_query: "stored" }]);
  db.seed("intelligence_item_sections", o.sections ?? [{ id: "sec1", item_id: ITEM, section_key: "record_facts", section_order: 2, content_md: "" }]);
  db.seed("section_claim_provenance", (o.claims ?? []).map((c, i) => ({ id: `cl${i + 1}`, intelligence_item_id: ITEM, section_row_id: "sec1", source_id: SOURCE, search_result_id: "cap1", source_tier_at_grounding: 1, basis_claim_id: null, ...c })));
  return db;
}
const covers = [{ claim_kind: "GAP", claim_text: "[binding_position] No verbatim statement.", source_span: null, source_id: null, search_result_id: null, source_tier_at_grounding: null }, { claim_kind: "GAP", claim_text: "[due_date] No verbatim statement.", source_span: null, source_id: null, search_result_id: null, source_tier_at_grounding: null }];
const fact = (span: string, text = span) => ({ claim_kind: "FACT", claim_text: text, source_span: span });
const heal = (db: WorldDb, input: Partial<Parameters<typeof healItem>[1]> = {}, depsOver: Parameters<typeof makeDeps>[1] = {}) => healItem({ sb: makeDeps(db, depsOver).deps.sb, now: () => new Date("2026-10-15T12:00:00.000Z"), fetch: makeDeps(db, depsOver).deps.fetch }, { itemId: ITEM, dry: false, ...input });
const claimsOf = (db: WorldDb) => db.rows("section_claim_provenance").filter((c) => c.intelligence_item_id === ITEM);

test("heal: a span the capture carries only after normalisation is re-pointed to the byte-exact slice; the claim text is never touched; the item re-derives verified", async () => {
  const db = healWorld({ claims: [...covers, fact("Operators of the ‘CBAM’ scheme pay EUR 50 000 per breach.", "The penalty claim as written")].map((c, i) => (i === 2 ? { ...c, search_result_id: null } : c)) });
  const r = await heal(db);
  assert.equal(r.outcome, "ok", r.notes.join("; "));
  assert.equal(r.status, "verified");
  const c = claimsOf(db).find((x) => x.claim_kind === "FACT")!;
  assert.equal(c.source_span, "Operators of the 'CBAM' scheme pay EUR 50 000 per breach.");
  assert.equal(c.claim_text, "The penalty claim as written", "INV-298: a heal never replaces claim text");
  assert.equal(c.search_result_id, "cap1");
  assert.equal(r.counts.ground_healed, 1);
  assert.equal(db.rows("item_gate_a_state").length, 1, "the Gate A state is written before the re-derive");
});

test("INV-298: a figure that differs in value never grounds; the FACT is re-kinded to ANALYSIS in place when its text is in the section, and left as FACT (reported) when it is not", async () => {
  const db = healWorld({
    captureText: "The total is 12,345 tonnes in the period. Operators shall report annually before 30 April of each year.",
    sections: [{ id: "sec1", item_id: ITEM, section_key: "record_facts", section_order: 2, content_md: "Intro.\n\nThe total reported is 12.345 tonnes." }],
    claims: [...covers, fact("12.345", "The total reported is 12.345 tonnes"), fact("a span nowhere", "a claim in no section")],
  });
  const r = await heal(db);
  const [a, b] = claimsOf(db).filter((x) => x.claim_kind !== "GAP" || String(x.claim_text).includes("12.345") || String(x.claim_text).includes("no section"));
  assert.deepEqual([a?.claim_kind, a?.claim_text], ["ANALYSIS", "The total reported is 12.345 tonnes"], "re-kinded, text unchanged");
  assert.deepEqual([b?.claim_kind, b?.claim_text], ["FACT", "a claim in no section"], "refused: left as FACT, not rewritten");
  assert.equal(r.counts.reclassified_analysis, 1);
  assert.equal(r.counts.reclassify_refused, 1);
  assert.match(String(db.rows("intelligence_item_sections")[0]?.content_md), /\*Analytical inference:\* The total reported is 12\.345 tonnes\./);
  assert.equal(r.outcome, "partial");
  assert.notEqual(r.status, "verified");
});

test("heal: a required slot no claim covers is written from the capture (FACT when the source states it, else an honest GAP) into the record_facts section", async () => {
  const db = healWorld({ claims: [fact("Operators shall report verified annual emissions before 30 April of each year.")] });
  const r = await heal(db);
  assert.equal(r.counts.slots_written, 2, r.notes.join("; "));
  const slotClaims = claimsOf(db).filter((c) => /^\[(binding_position|due_date)\]/.test(String(c.claim_text)));
  assert.equal(slotClaims.length, 2);
  assert.ok(slotClaims.every((c) => c.claim_kind === "FACT" || c.claim_kind === "GAP"));
  assert.ok(String(db.rows("intelligence_item_sections")[0]?.content_md).includes("[binding_position]"));
});

test("heal: a required-slot FACT that cannot be proven becomes the slot's GAP", async () => {
  const db = healWorld({ claims: [{ claim_kind: "FACT", claim_text: "[binding_position] The captured source states, verbatim: «does not exist»", source_span: "does not exist" }, covers[1]!, fact("Operators shall report verified annual emissions before 30 April of each year.")] });
  await heal(db);
  const slot = claimsOf(db).find((c) => String(c.claim_text).startsWith("[binding_position]"))!;
  assert.deepEqual([slot.claim_kind, slot.source_span, slot.source_id, slot.search_result_id], ["GAP", null, null, null]);
  assert.match(String(slot.claim_text), /No verbatim/);
});

const PAGE = `<html><head><title>Penalty schedule</title></head><body><p>${"The schedule of penalties under the scheme is set out below for operators of cargo aircraft. ".repeat(4)} The penalty is EUR 50 000 per breach of the reporting duty.</p></body></html>`;
const fetcher = (pages: Record<string, string>) => (async (u: string) => (pages[String(u)] !== undefined ? new Response(pages[String(u)], { headers: { "content-type": "text/html" } }) : new Response("not found", { status: 404 }))) as typeof fetch;

test("rule 18: an orphan figure no capture carries is sourced from a URL the item cites, the page is registered and RATED through the registry (class-table tier), and the figure is grounded verbatim on it", async () => {
  const url = "https://publications.europa.eu/resource/doc/penalties";
  const db = healWorld({ brief: "The penalty is EUR 50 000 per breach.", sections: [{ id: "sec1", item_id: ITEM, section_key: "record_facts", section_order: 2, content_md: `The penalty is EUR 50 000 per breach. See ${url}` }], claims: [...covers, fact("Operators shall report verified annual emissions before 30 April of each year.")], captureText: "Operators shall report verified annual emissions before 30 April of each year. Regulation text only." });
  const fetchDeps = { fetch: { db: db.client, env: {}, caller: "manual-intake-run", fetchImpl: fetcher({ [url]: PAGE }) } };
  const r = await heal(db, {}, fetchDeps);
  const expectedTier = classTierForHost("publications.europa.eu");
  assert.ok(expectedTier != null, "the host places in a class");
  const src = db.rows("sources").find((s) => s.url === url);
  assert.ok(src, "the cited page was registered");
  assert.equal(src?.base_tier, expectedTier, "the tier is the class table's, never typed here");
  const orphan = claimsOf(db).find((c) => c.claim_text === "The penalty is EUR 50 000 per breach.");
  assert.deepEqual([orphan?.claim_kind, orphan?.source_span, orphan?.source_id, orphan?.source_tier_at_grounding], ["FACT", "The penalty is EUR 50 000 per breach of the reporting duty.", src?.id, expectedTier], "the claim is the brief's own sentence, the span the page's verbatim sentence");
  assert.ok(!claimsOf(db).some((c) => String(c.claim_text).startsWith("The captured source text states")), "no sentence is generated");
  assert.equal(r.counts.orphans_sourced, 1, r.notes.join("; "));
  assert.ok(PAGE.includes(orphan?.source_span ?? "NO_SPAN"), "INV-003: the figure attaches with its URL and a quote verbatim on the page");
  assert.equal(db.rows("agent_run_searches").find((x) => x.id === orphan?.search_result_id)?.result_url, url);
  assert.equal((db.rows("item_gate_a_state")[0] as { orphan_count: number }).orphan_count, 0);
  assert.equal(db.rows("agent_run_searches").filter((x) => x.result_url === url).length, 1, "the cited page is stored as a pool row");
});

test("rule 18: a host the registry never rates (a hosting platform) leaves the figure an orphan and registers nothing; a page that lacks the figure is followed ONE hop to a same-institution link", async () => {
  const platform = "https://consult.citizenspace.com/penalties";
  const db1 = healWorld({ brief: "The penalty is EUR 50 000 per breach.", sections: [{ id: "sec1", item_id: ITEM, section_key: "record_facts", section_order: 2, content_md: `Penalty EUR 50 000. ${platform}` }], claims: [...covers, fact("Operators shall report verified annual emissions before 30 April of each year.")], captureText: "Operators shall report verified annual emissions before 30 April of each year. Regulation text only." });
  const r1 = await heal(db1, {}, { fetch: { db: db1.client, env: {}, caller: "manual-intake-run", fetchImpl: fetcher({ [platform]: PAGE }) } });
  assert.equal(r1.counts.orphans_sourced ?? 0, 0);
  assert.equal(db1.rows("sources").filter((s) => s.url === platform).length, 0);
  assert.equal((db1.rows("item_gate_a_state")[0] as { orphan_count: number }).orphan_count, 1, "the figure is still an orphan on the Gate A state");
  assert.ok((r1.steps.source as string[]).some((s) => s.includes("unrated_host")));
  const index = "https://publications.europa.eu/resource/doc/index";
  const child = "https://publications.europa.eu/resource/doc/penalties-annex";
  const db2 = healWorld({ brief: "The penalty is EUR 50 000 per breach.", sections: [{ id: "sec1", item_id: ITEM, section_key: "record_facts", section_order: 2, content_md: `Penalty EUR 50 000. ${index}` }], claims: [...covers, fact("Operators shall report verified annual emissions before 30 April of each year.")], captureText: "Operators shall report verified annual emissions before 30 April of each year. Regulation text only." });
  const indexPage = `<html><body><p>${"An index page that lists the annexes of the scheme and says nothing about money. ".repeat(5)}</p><a href="${child}">annex</a><a href="https://elsewhere.example/x">out</a></body></html>`;
  const r2 = await heal(db2, {}, { fetch: { db: db2.client, env: {}, caller: "manual-intake-run", fetchImpl: fetcher({ [index]: indexPage, [child]: PAGE }) } });
  assert.equal(r2.counts.orphans_sourced, 1, r2.notes.join("; "));
  assert.ok(db2.rows("agent_run_searches").some((x) => x.result_url === child), "the one-hop page was captured");
  assert.ok(!db2.rows("agent_run_searches").some((x) => x.result_url === "https://elsewhere.example/x"), "a link outside the institution is never followed");
});

test("heal: the honest strip is opt-in; without the flag the brief is untouched, with it the accepted strip is applied and the previous text comes back for restore", async () => {
  const brief = "The regime applies to vessels. The penalty is EUR 50 000 per breach. Reports are annual.";
  const mk = () => healWorld({ brief, claims: [...covers, fact("Operators shall report verified annual emissions before 30 April of each year.")], captureText: "Operators shall report verified annual emissions before 30 April of each year." });
  const off = mk();
  const r0 = await heal(off);
  assert.equal(off.rows("intelligence_items")[0]?.full_brief, brief, "not applied without the flag");
  assert.equal(r0.restore, undefined);
  const on = mk();
  const r1 = await heal(on, { stripUnprovable: true });
  assert.equal(on.rows("intelligence_items")[0]?.full_brief, "The regime applies to vessels. Reports are annual.");
  assert.deepEqual(r1.restore, { itemId: ITEM, previous: brief });
  assert.equal(r1.counts.brief_stripped, 1);
  assert.equal((on.rows("item_gate_a_state")[0] as { orphan_count: number }).orphan_count, 0);
});

test("a dry heal plans and writes nothing; a failed read fails the item with its step named", async () => {
  const db = healWorld({ claims: [...covers, fact("Operators of the ‘CBAM’ scheme pay EUR 50 000 per breach.")] });
  const r = await heal(db, { dry: true });
  assert.equal(db.calls.filter((c) => c.op !== "select").length, 0, "no write of any kind");
  assert.equal(r.counts.ground_healed, 1, "the plan still counts what it would heal");
  const db2 = healWorld({ claims: [] });
  db2.failWhen = (c) => (c.table === "intelligence_item_sections" ? "connection reset" : null);
  const bad = await heal(db2);
  assert.equal(bad.outcome, "failed");
  assert.match(bad.notes.at(-1) ?? "", /paginated read failed|connection reset/);
  const missing = await heal(healWorld(), { itemId: "nope" });
  assert.equal(missing.outcome, "failed");
});

test("healQuarantined heals each quarantined item in turn; one item's failure never stops the rest; verified and archived items are not selected", async () => {
  const db = healWorld({ claims: [...covers, fact("Operators shall report verified annual emissions before 30 April of each year.")] });
  const B = "a0000000-0000-4000-8000-0000000000bb";
  db.seed("intelligence_items", [{ id: B, item_type: "regulation", priority: "HIGH", source_id: SOURCE, source_url: "https://eur-lex.europa.eu/other", full_brief: "x", is_archived: false, provenance_status: "quarantined" }, { id: "a0000000-0000-4000-8000-0000000000cc", item_type: "regulation", is_archived: false, provenance_status: "verified" }, { id: "a0000000-0000-4000-8000-0000000000dd", item_type: "regulation", is_archived: true, provenance_status: "quarantined" }]);
  db.failWhen = (c) => (c.table === "agent_run_searches" && c.filters.some(([, col, v]) => col === "intelligence_item_id" && v === B) ? "disk error" : null);
  const deps = makeDeps(db).deps;
  const r = await healQuarantined({ sb: deps.sb, now: deps.now, fetch: deps.fetch }, { dry: false, limit: 10 });
  assert.equal(r.counts.items, 2);
  assert.equal(r.counts.failed, 1);
  assert.equal(r.outcome, "partial");
  assert.deepEqual(r.results.map((x) => x.outcome).sort(), ["failed", "ok"]);
  assert.ok(r.results.some((x) => x.itemId === ITEM && x.status === "verified"));
});

test("an archived-unreasoned item that now verifies is un-archived (and only that selection)", async () => {
  const db = healWorld({ claims: [...covers, fact("Operators shall report verified annual emissions before 30 April of each year.")] });
  Object.assign(db.rows("intelligence_items")[0]!, { is_archived: true, archive_reason: null });
  const r = await heal(db, { selection: "archived-unreasoned" });
  assert.equal(r.counts.unarchived, 1);
  assert.equal(db.rows("intelligence_items")[0]?.is_archived, false);
  const db2 = healWorld({ claims: [...covers, fact("Operators shall report verified annual emissions before 30 April of each year.")] });
  Object.assign(db2.rows("intelligence_items")[0]!, { is_archived: true, archive_reason: "off_vertical" });
  await heal(db2, { selection: "quarantined" });
  assert.equal(db2.rows("intelligence_items")[0]?.is_archived, true, "an archive with a reason is never reversed by a heal");
});

test("rederiveStale touches only the record items the function says verify now; the status itself is never written here", async () => {
  const db = healWorld({ claims: [...covers, fact("Operators shall report verified annual emissions before 30 April of each year.")] });
  db.seed("intelligence_items", [{ id: "a0000000-0000-4000-8000-0000000000ee", item_type: "regulation", item_grade: "record", is_archived: false, provenance_status: "quarantined" }]);
  const deps = makeDeps(db).deps;
  const h = { sb: deps.sb, now: deps.now, fetch: deps.fetch };
  const dry = await rederiveStale(h, {});
  assert.deepEqual([dry.counts.candidates, dry.counts.stale, dry.counts.still_invalid, dry.counts.touched], [2, 1, 1, 0]);
  assert.equal(db.writes("intelligence_items", "update").length, 0);
  Object.assign(db.rows("intelligence_items")[0]!, { provenance_status: "quarantined" });
  const done = await rederiveStale(h, { dry: false });
  assert.equal(done.counts.touched, 1);
  assert.deepEqual(db.writes("intelligence_items", "update").map((w) => Object.keys(w.payload as object)), [["updated_at"]]);
});
