// The provenance healer: INV-298 (a value-preserving numeric fold, re-kind never rewrite), the position-preserving normaliser, floors and buckets, source-and-rate for an orphan
// figure (rule 18), the opt-in honest strip, and the re-derive. Every read and write is checked, and dry mode writes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeNumeric } from "@/core/contracts/numbers";
import { classTierForHost } from "@/core/sources";
import { healItem, healQuarantined, rederiveStale } from "@/features/mint";
import { buildBuckets, buildSourcesIndex, claimNeedsResource, locateSpan, planGrounding, planResource, type Capture, type HealClaim } from "@/features/mint/heal/ground";
import { planBriefHonest } from "@/features/mint/heal/brief-honest";
import { planReclassify, planRelabelFromFullBrief, planRelabelModal, planRelabelParagraph } from "@/features/mint/heal/label";

import { CELEX_URL, SOURCE, makeDeps, makeWorld, type WorldDb } from "./world.ts";

const cap = (text: string, id = "cap1"): Capture => ({ id, result_url: CELEX_URL, result_content: text });
const claim = (over: Partial<HealClaim>): HealClaim => ({ id: "c1", claim_kind: "FACT", claim_text: "t", source_span: null, source_id: null, search_result_id: null, section_row_id: null, ...over });

test("INV-298: the numeric fold is by VALUE, read through the parse module under the locale of the text that prints the number", () => {
  const f = (s: string, locale?: string) => normalizeNumeric(s, locale).chars;
  assert.deepEqual(["1 200 000", "1,200,000", "1.200.000", "1 200"].map((s) => f(s)), ["1200000", "1200000", "1200000", "1200"]);
  assert.deepEqual(["35,5", "35.5", "0,75"].map((s) => f(s)), ["35.5", "35.5", "0.75"]);
  assert.deepEqual(["1.234,56", "1,234.56"].map((s) => f(s)), ["1234.56", "1234.56"], "a thousands group then a decimal");
  assert.equal(f("12.345"), "12.345", "alone, one point and three digits read as a decimal point");
  assert.equal(f("12,345"), "12345", "alone, one comma and three digits read as thousands");
  assert.notEqual(f("12.345"), f("12,345"), "the two never fold onto one value");
  assert.equal(f("12.345", "de"), "12345", "the capture declares German: the point is the thousands separator");
  assert.equal(f("12,345", "de-AT"), "12.345", "a BCP-47 tag reads by its language: the comma is the decimal separator");
  assert.equal(f("5 12"), "5 12", "a space before a non-thousands group is two numbers");
  assert.equal(f("EUR 15 million"), f("€15 million"), "a figure folds to its value and unit, whichever way the currency is printed");
  assert.notEqual(f("EUR 15 million"), f("EUR 150 million"));
  const r = normalizeNumeric("1,200,000");
  assert.equal(r.map.length, r.chars.length + 1, "every folded character maps back to the capture, plus the end");
  assert.equal(r.ends.length, r.chars.length);
  assert.equal(normalizeNumeric("1,2,3,4 and 5", "en").refused === null, false, "a number the parser cannot read refuses the view");
  assert.equal(normalizeNumeric("see 1.200,5 and 1,200.5").refused === null, false, "a text that mixes two conventions has no locale: refused, not guessed");
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
  assert.equal(slot.kind === "gap" ? slot.claim_text : "", "[binding_position] M");
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

const newOf = (p: ReturnType<typeof planBriefHonest>): string => ("newFullBrief" in p ? p.newFullBrief : "");

test("the honest strip removes whole sentences only (ADR-050), and is ACCEPTED only when Gate A then finds no orphan", () => {
  const single = "The regime applies to vessels. The penalty is EUR 50 000 per breach. Reports are annual.";
  const accepted = planBriefHonest(single, ["EUR 50 000"], []);
  assert.equal(accepted.outcome, "accepted");
  assert.equal(newOf(accepted), "The regime applies to vessels. Reports are annual.");
  assert.equal("previous" in accepted ? accepted.previous : "", single);
  assert.deepEqual(accepted.perToken[0]?.removed, ["The penalty is EUR 50 000 per breach."]);
  assert.equal(planBriefHonest("Nothing to strip.", ["EUR 5"], []).outcome, "no_op");
});

test("HEAL-1c: a sentence that also states a proven token is KEPT whole (never cut to a clause) and its unprovable token is listed as residue with the sentence", () => {
  const two = "Fines are EUR 50 000, due 1 January 2027, and apply to vessels. Reports are annual.";
  const facts = [{ claim_text: "due 1 January 2027", source_span: "due 1 January 2027" }];
  const plan = planBriefHonest(two, ["EUR 50 000"], facts);
  assert.equal(plan.outcome, "no_op", "nothing is removed: the date is proven, so the sentence stays whole");
  assert.deepEqual(plan.residue, [{ token: "EUR 50 000", sentence: "Fines are EUR 50 000, due 1 January 2027, and apply to vessels." }]);
  assert.deepEqual(plan.perToken.map((t) => t.outcome), ["kept:sentence_states_a_proven_token"]);
  const mixed = planBriefHonest(`${two} The fee is EUR 70 000.`, ["EUR 50 000", "EUR 70 000"], facts);
  assert.equal(mixed.outcome, "partial", "the all-unprovable sentence went, the mixed one stayed, Gate A still finds the residue");
  assert.equal(newOf(mixed), two);
  assert.deepEqual(mixed.stripped, ["The fee is EUR 70 000."]);
  assert.deepEqual(mixed.residue.map((r) => r.token), ["EUR 50 000"]);
  assert.equal("orphanCount" in mixed ? mixed.orphanCount : -1, 1);
});

test("HEAL-1b: a table row or list item goes whole whatever else it states, while prose that also states a figure that stays is still protected", () => {
  const brief = ["The limits follow.", "- 2035: 77.94 gCO₂eq/MJ (14.5% reduction)", "| 1 January 2035 | Target rises to 14.5% (limit: 77.94 gCO₂eq/MJ) | Upcoming |", "The 2035 target is 14.5% and the limit is 77.94 gCO₂eq/MJ."].join("\n");
  const plan = planBriefHonest(brief, ["77.94 gCO₂"], []);
  assert.deepEqual(plan.perToken[0]?.outcome, "kept:sentence_states_a_proven_token", "the prose sentence also states 14.5%, a figure that stays; the rows of the same brief go whole");
  assert.equal(plan.residue.at(-1)?.sentence, "The 2035 target is 14.5% and the limit is 77.94 gCO₂eq/MJ.");
  const rows = ["The limits follow.", "- 2035: 77.94 gCO₂eq/MJ (14.5% reduction)", "| 1 January 2035 | Target rises to 14.5% (limit: 77.94 gCO₂eq/MJ) | Upcoming |", "Reports are annual."].join("\n");
  const cut = planBriefHonest(rows, ["77.94 gCO₂"], [{ claim_text: "1 January 2035, 14.5%", source_span: "1 January 2035, 14.5%" }]);
  assert.equal(cut.outcome === "accepted" ? cut.newFullBrief : "", ["The limits follow.", "Reports are annual."].join("\n"));
  assert.deepEqual(cut.perToken[0]?.removed, ["- 2035: 77.94 gCO₂eq/MJ (14.5% reduction)", "| 1 January 2035 | Target rises to 14.5% (limit: 77.94 gCO₂eq/MJ) | Upcoming |"]);
});

test("HEAL-1b: a sentence whose every figure and date is being removed goes whole, and a token goes from EVERY place it stands, but never out of a longer number or a dated day", () => {
  const brief = ["Costs are about €15 in 2024, €27 in 2025, and €44 in 2026.", "The cap is €150.", "| 31 March 2026 | Verifier notifies |", "| March 2026 | Council decision |", "See March 2026 again."].join("\n");
  const plan = planBriefHonest(brief, ["€15", "€27", "€44", "March 2026"], [{ claim_text: "The cap is €150.", source_span: "The cap is €150." }, { claim_text: "| 31 March 2026 | Verifier notifies |", source_span: "31 March 2026 | Verifier notifies" }]);
  const out = plan.outcome === "accepted" ? plan.newFullBrief : "";
  assert.ok(out.includes("The cap is €150."), "€15 is not inside €150");
  assert.ok(out.includes("| 31 March 2026 |"), "March 2026 is not inside 31 March 2026");
  assert.ok(!out.includes("€27") && !out.includes("€44") && !out.includes("Council decision") && !out.includes("again"), out);
  assert.equal(plan.perToken.find((t) => t.token === "March 2026")?.removed?.length, 2, "both standing occurrences were cut");
  const three = ["€15", "€27", "€44"].map((t) => plan.perToken.find((x) => x.token === t));
  assert.ok(three.every((t) => t?.outcome === "sentence" && t.removed?.length === 1), "HEAL-1c: three tokens in one sentence strip that sentence once and each token counts it");
  assert.equal(plan.stripped.filter((x) => x.includes("€27")).length, 1);
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
  assert.match(String(slot.claim_text), /^\[[a-z_]+\] M$/);
});

const PAGE = `<html><head><title>Penalty schedule</title></head><body><p>${"The schedule of penalties under the scheme is set out below for operators of cargo aircraft. ".repeat(4)} The penalty is EUR 50 000 per breach of the reporting duty.</p></body></html>`;
const fetcher = (pages: Record<string, string>) => (async (u: string) => (pages[String(u)] !== undefined ? new Response(pages[String(u)], { headers: { "content-type": "text/html" } }) : new Response("not found", { status: 404 }))) as typeof fetch;

test("rule 18: an orphan figure no capture carries is sourced from a URL the item cites, the page is registered and RATED through the registry (class-table tier), and the figure is grounded verbatim on it", async () => {
  const url = "https://publications.europa.eu/resource/doc/penalties";
  const db = healWorld({ brief: "The penalty is EUR 50 000 per breach.", sections: [{ id: "sec1", item_id: ITEM, section_key: "record_facts", section_order: 2, content_md: `The penalty is EUR 50 000 per breach. See ${url}` }], claims: [...covers, fact("Operators shall report verified annual emissions before 30 April of each year.")], captureText: "Operators shall report verified annual emissions before 30 April of each year. Regulation text only." });
  const fetchDeps = { fetch: { db: db.client, resolveHost: null, throttle: null, env: {}, caller: "manual-intake-run", fetchImpl: fetcher({ [url]: PAGE }) } };
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
  assert.ok(PAGE.includes(String(orphan?.source_span ?? "NO_SPAN")), "INV-003: the figure attaches with its URL and a quote verbatim on the page");
  assert.equal(db.rows("agent_run_searches").find((x) => x.id === orphan?.search_result_id)?.result_url, url);
  assert.equal((db.rows("item_gate_a_state")[0] as { orphan_count: number }).orphan_count, 0);
  assert.equal(db.rows("agent_run_searches").filter((x) => x.result_url === url).length, 1, "the cited page is stored as a pool row");
});

test("HEAL-1: the heal as a ruled plan fires it (no signed caller) while the scrape cadence is off reaches the network for nothing: the cited page is never requested, the orphan is reported as fetch_held, and the pass runs to the end over the stored captures", async () => {
  const url = "https://publications.europa.eu/resource/doc/penalties";
  const db = healWorld({ brief: "The penalty is EUR 50 000 per breach.", sections: [{ id: "sec1", item_id: ITEM, section_key: "record_facts", section_order: 2, content_md: `The penalty is EUR 50 000 per breach. See ${url}` }], claims: [...covers, fact("operators shall report verified annual emissions before 30 april of each year.")], captureText: "Operators shall report verified annual emissions before 30 April of each year. Regulation text only." });
  const requested: string[] = [];
  const fetchImpl = (async (u: string) => (requested.push(String(u)), new Response(PAGE, { headers: { "content-type": "text/html" } }))) as typeof fetch;
  const r = await heal(db, {}, { fetch: { db: db.client, resolveHost: null, throttle: null, env: {}, fetchImpl } });
  assert.deepEqual(requested, [], "nothing was requested from the network");
  assert.notEqual(r.outcome, "failed", r.notes.join("; "));
  assert.deepEqual(r.steps.source, ["EUR 50 000: fetch_held"]);
  assert.equal(r.counts.orphans_sourced ?? 0, 0);
  assert.equal(r.steps.capture, "held:fetch_hold:cadence_off", "a thin stored capture is not a reason to fetch while the hold is on, and not a failure of the item");
  assert.equal(r.steps.cited, "held:fetch_hold:cadence_off");
  assert.equal((db.rows("item_gate_a_state")[0] as { orphan_count: number }).orphan_count, 1, "the pass ran to the end over the stored captures and wrote the Gate A state");
});

test("HEAL-1b: the heal repairs the attributions the database lists and no others: on a fixture shaped like the two items (150 FACTs, 37 of them on ec.europa.eu subdomains standing on finance.ec.europa.eu) the 150 rewrites the resolver preferred collapse to the 37 violations", async () => {
  const OLD_ROOT = "a0000000-0000-4000-8000-0000000000e1";
  const FIN = "c0000000-0000-4000-8000-0000000000f1";
  const OK = 113;
  const BAD = 37;
  const sentences = (tag: string, n: number): string[] => Array.from({ length: n }, (_, i) => `The ${tag} provision number ${i + 1} sets out the obligations of operators under the scheme in full.`);
  const okText = sentences("eur-lex", OK);
  const badText = sentences("transport", BAD);
  const db = healWorld({
    captureText: okText.join(" "),
    claims: [...covers, ...okText.map((t) => fact(t)), ...badText.map((t) => ({ ...fact(t), search_result_id: "cap2", source_id: FIN, source_tier_at_grounding: 2 }))],
  });
  db.seed("sources", [
    { id: OLD_ROOT, name: "EUR-Lex root", url: "https://eur-lex.europa.eu/", base_tier: 1, tier_override: null, status: "active", institution_id: null, category: "regulatory" },
    { id: FIN, name: "Finance", url: "https://finance.ec.europa.eu/", base_tier: 2, tier_override: null, status: "active", institution_id: null, category: "regulatory" },
  ]);
  db.seed("agent_run_searches", [{ id: "cap2", intelligence_item_id: ITEM, result_url: "https://transport.ec.europa.eu/transport-modes/fueleu-maritime_en", result_content: badText.join(" "), result_index: 1, search_query: "stored" }]);
  const violations = () => (db.client as unknown as { rpc: (n: string, a: unknown) => Promise<{ data: { claim_id: string }[] }> }).rpc("ledger_attribution_violations", { p_item_id: ITEM }).then((r) => r.data);
  assert.equal((await violations()).length, BAD, "the fixture is the production shape: source_host_mismatch FACTs on subdomain captures");
  const r = await heal(db);
  assert.notEqual(r.outcome, "failed", r.notes.join("; "));
  assert.equal(r.counts.attribution_repaired, BAD, "only the claims the database lists; the resolver's own preference for the first eur-lex row is no reason to rewrite correct claims");
  assert.equal(r.counts.ledger_ops, BAD);
  assert.equal(r.counts.healed, 1, "a pass that wrote counts under the ops family's write key, so its row is not a noop");
  assert.deepEqual(await violations(), [], "after the heal the database lists none");
  const moved = claimsOf(db).filter((c) => c.search_result_id === "cap2");
  assert.equal(moved.length, BAD);
  assert.ok(moved.every((c) => c.source_id !== FIN && String(db.rows("sources").find((s) => s.id === c.source_id)?.url).includes("transport.ec.europa.eu")), "re-stood on a source registered on the capture's own host (rule 18)");
  assert.ok(claimsOf(db).filter((c) => c.search_result_id === "cap1" && c.claim_kind === "FACT").every((c) => c.source_id === SOURCE), "the correct claims keep their source");
});

/** The shape of the production items: `bad` FACTs on a transport.ec.europa.eu capture standing on the finance source (the database lists each as a violation), `ok` correct ones. */
function violationWorld(bad: number, ok = 10) {
  const FIN = "c0000000-0000-4000-8000-0000000000f1";
  const sentences = (tag: string, n: number): string[] => Array.from({ length: n }, (_, i) => `The ${tag} provision number ${i + 1} sets out the obligations of operators under the scheme in full.`);
  const okText = sentences("eur-lex", ok);
  const badText = sentences("transport", bad);
  const db = healWorld({ captureText: okText.join(" "), claims: [...covers, ...okText.map((t) => fact(t)), ...badText.map((t) => ({ ...fact(t), search_result_id: "cap2", source_id: FIN, source_tier_at_grounding: 2 }))] });
  db.seed("sources", [{ id: FIN, name: "Finance", url: "https://finance.ec.europa.eu/", base_tier: 2, tier_override: null, status: "active", institution_id: null, category: "regulatory" }]);
  db.seed("agent_run_searches", [{ id: "cap2", intelligence_item_id: ITEM, result_url: "https://transport.ec.europa.eu/transport-modes/fueleu-maritime_en", result_content: badText.join(" "), result_index: 1, search_query: "stored" }]);
  const violations = () => (db.client as unknown as { rpc: (n: string, a: unknown) => Promise<{ data: unknown[] }> }).rpc("ledger_attribution_violations", { p_item_id: ITEM }).then((r) => r.data);
  /** The database as production behaves: a call that carries more than `limit` ops runs past the statement timeout and changes nothing; `failAt` fails the n-th call (1-based) the same way. */
  const sizes: number[] = [];
  const fail = { at: 0 };
  const guard = (limit: number, failAt = 0) => {
    fail.at = failAt;
    const real = db.rpcs.ledger_apply_ops as NonNullable<typeof db.rpcs.ledger_apply_ops>;
    db.rpcs.ledger_apply_ops = (a, d) => {
      sizes.push((a.p_ops as unknown[]).length);
      return (a.p_ops as unknown[]).length > limit || sizes.length === fail.at ? { error: { message: "canceling statement due to statement timeout", code: "57014" } } : real(a, d);
    };
  };
  return { db, violations, sizes, guard, fail };
}

test("HEAL-1c: 60 ledger ops against a database that times out above 20 per call are applied in chunks of 5, each its own transaction, and a second pass writes nothing", async () => {
  const w = violationWorld(60);
  w.guard(20);
  assert.equal((await w.violations()).length, 60);
  const r = await heal(w.db);
  assert.notEqual(r.outcome, "failed", r.notes.join("; "));
  assert.equal(r.counts.ledger_ops, 60);
  assert.deepEqual([...new Set(w.sizes)], [5], "12 calls of 5 ops, none near the limit");
  assert.equal(w.sizes.length, 12);
  assert.deepEqual(await w.violations(), [], "every attribution is repaired");
  w.sizes.length = 0;
  const again = await heal(w.db);
  assert.equal(again.counts.ledger_ops, undefined, "the committed chunks are in the database: the next pass plans no op");
  assert.deepEqual(w.sizes, []);
});

test("HEAL-1c: a chunk that fails fails the item with the chunk named, leaves the earlier chunks committed and the status untouched; the next pass applies only what is left", async () => {
  const w = violationWorld(60);
  w.guard(20, 3);
  const r = await heal(w.db);
  assert.equal(r.outcome, "failed");
  assert.match(r.notes.at(-1) ?? "", /ledger chunk 3 of 12 \(10 of 60 ops already committed\): .*statement timeout/);
  assert.equal(r.status, "quarantined", "the item stays quarantined: no touch, no verdict");
  assert.equal(w.db.rows("intelligence_items")[0]?.provenance_status, "quarantined");
  assert.equal((await w.violations()).length, 50, "chunks 1 and 2 stand");
  w.sizes.length = 0;
  w.fail.at = 0;
  const next = await heal(w.db);
  assert.equal(next.counts.ledger_ops, 50, "only the 50 still-listed attributions are planned");
  assert.equal(w.sizes.length, 10);
  assert.deepEqual(await w.violations(), []);
});

test("rule 18: a host the registry never rates (a hosting platform) leaves the figure an orphan and registers nothing; a page that lacks the figure is followed ONE hop to a same-institution link", async () => {
  const platform = "https://consult.citizenspace.com/penalties";
  const db1 = healWorld({ brief: "The penalty is EUR 50 000 per breach.", sections: [{ id: "sec1", item_id: ITEM, section_key: "record_facts", section_order: 2, content_md: `Penalty EUR 50 000. ${platform}` }], claims: [...covers, fact("Operators shall report verified annual emissions before 30 April of each year.")], captureText: "Operators shall report verified annual emissions before 30 April of each year. Regulation text only." });
  const r1 = await heal(db1, {}, { fetch: { db: db1.client, resolveHost: null, throttle: null, env: {}, caller: "manual-intake-run", fetchImpl: fetcher({ [platform]: PAGE }) } });
  assert.equal(r1.counts.orphans_sourced ?? 0, 0);
  assert.equal(db1.rows("sources").filter((s) => s.url === platform).length, 0);
  assert.equal((db1.rows("item_gate_a_state")[0] as { orphan_count: number }).orphan_count, 1, "the figure is still an orphan on the Gate A state");
  assert.ok((r1.steps.source as string[]).some((s) => s.includes("unrated_host")));
  const index = "https://publications.europa.eu/resource/doc/index";
  const child = "https://publications.europa.eu/resource/doc/penalties-annex";
  const db2 = healWorld({ brief: "The penalty is EUR 50 000 per breach.", sections: [{ id: "sec1", item_id: ITEM, section_key: "record_facts", section_order: 2, content_md: `Penalty EUR 50 000. ${index}` }], claims: [...covers, fact("Operators shall report verified annual emissions before 30 April of each year.")], captureText: "Operators shall report verified annual emissions before 30 April of each year. Regulation text only." });
  const indexPage = `<html><body><p>${"An index page that lists the annexes of the scheme and says nothing about money. ".repeat(5)}</p><a href="${child}">annex</a><a href="https://elsewhere.example/x">out</a></body></html>`;
  const r2 = await heal(db2, {}, { fetch: { db: db2.client, resolveHost: null, throttle: null, env: {}, caller: "manual-intake-run", fetchImpl: fetcher({ [index]: indexPage, [child]: PAGE }) } });
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

test("HEAL-1c: the strip is per sentence: the all-unprovable sentence goes, the sentence that also states a proven date stays whole and its unprovable figure comes back as residue; the strip stands though the item is not yet released", async () => {
  const kept = "The Regulation applies from 1 January 2027 and the penalty is EUR 60 000 per breach.";
  const brief = `${kept} Fines reach EUR 70 000. Reports are annual.`;
  const db = healWorld({ brief, claims: [...covers, fact("This Regulation shall enter into force on 1 January 2027 and shall be binding in its entirety.")] });
  const r = await heal(db, { stripUnprovable: true });
  assert.notEqual(r.outcome, "failed", r.notes.join("; "));
  assert.equal(db.rows("intelligence_items")[0]?.full_brief, `${kept} Reports are annual.`);
  assert.deepEqual(r.steps.stripped, ["Fines reach EUR 70 000."]);
  assert.deepEqual(r.steps.residue, [{ token: "EUR 60 000", sentence: kept }]);
  assert.deepEqual([r.counts.strip_partial, r.counts.residue_tokens, r.counts.sentences_stripped], [1, 1, 1]);
  assert.equal((db.rows("item_gate_a_state")[0] as { orphan_count: number }).orphan_count, 1, "Gate A finds the residue, so the criterion keeps the item out");
  assert.deepEqual(r.restore, { itemId: ITEM, previous: brief });
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
