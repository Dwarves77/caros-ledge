// The pre-insert kit checks the database does not have: capture completeness (INV-296), unicode integrity (a hand-typed x for a multiplication sign, a straight quote for a
// curly one), record purity, record_hollow with the series exemption, and a present on_vertical screen (INV-294). The C1-C7 replica is gone: validate_item_provenance is the gate.
import assert from "node:assert/strict";
import { test } from "node:test";

import { preflight, tagPresence, type RecordPayload } from "@/features/mint";

import { builtPayload } from "./world.ts";

const ok = { isSeriesKey: (i: string | null | undefined) => i === "oil_bulletin_diesel" };
const reasons = (p: RecordPayload, o = ok) => preflight(p, o).failures.map((f) => `${String(f.criterion)}:${f.reason}`);
const clone = () => structuredClone(builtPayload().payload) as RecordPayload;

const R1242 = "Article 8\n\nCompliance with the specific CO2 emissions targets\n\n1. Where a manufacturer is found to have excess CO2 emissions in a given reporting period from 2025 onwards, the Commission shall impose an excess CO2 emissions premium, calculated in accordance with the following formula:\n\n(a)\n\nfrom 2025 to 2029,\n(Excess CO2 emissions premium) = (Excess CO2 emissions × 4 250 EUR/gCO2/tkm)";
const R0956 = "Article 1\n\nSubject matter\n\n1. This Regulation establishes a carbon border adjustment mechanism (the 'CBAM') to address greenhouse gas emissions embedded in the goods listed in Annex I on their importation into the customs territory of the Union.";

function withFact(span: string, text: string, archived?: string) {
  const p = clone();
  p.search_results[0]!.result_content = text;
  p.search_results[0]!.fetched_length = text.length;
  if (archived != null) (p.search_results[0] as { archived_source_text?: string }).archived_source_text = archived;
  p.claims = [{ section_key: "record_facts", claim_kind: "FACT", claim_text: `[effective_date] ${span}`, source_span: span, source_url: p.item.source_url as string, slot_key: "effective_date" }];
  p.item.full_brief = `- ${span}`;
  return p;
}

test("a well-formed record payload passes; only tag warnings (never a refusal) come back", () => {
  const r = preflight(clone(), ok);
  assert.deepEqual(r.failures, []);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.field === "*"), "all three signature tags empty is surfaced");
});

test("unicode integrity (the 32019R1242 bug): a span typed with an ascii x for the source's multiplication sign is named with its class and characters", () => {
  const bad = withFact("(Excess CO2 emissions premium) = (Excess CO2 emissions x 4 250 EUR/gCO2/tkm)", R1242.replace("×", "x"), R1242);
  const f = preflight(bad, ok).failures.find((x) => x.reason === "fact_span_matches_payload_only_not_archive");
  assert.ok(f, "the payload agrees with itself but not with the independently archived source");
  assert.deepEqual((f?.substitution as { class: string; span_char: string; reference_char: string }) ?? {}, { class: "multiplication_sign", span_char: "x", reference_char: "×", window: (f?.substitution as { window: string }).window });
  // with no archive the payload's own capture is the reference: a capture carrying the sign and a span without it is the same slip
  const noArchive = withFact("(Excess CO2 emissions premium) = (Excess CO2 emissions x 4 250 EUR/gCO2/tkm)", R1242);
  const noArchiveFailure = preflight(noArchive, ok).failures.find((x) => x.reason === "fact_span_unicode_substitution");
  assert.deepEqual([noArchiveFailure?.substitution_class, noArchiveFailure?.span_char, noArchiveFailure?.reference], ["multiplication_sign", "x", "result_content"]);
  const clean = withFact("(Excess CO2 emissions premium) = (Excess CO2 emissions × 4 250 EUR/gCO2/tkm)", R1242, R1242);
  assert.deepEqual(reasons(clean).filter((r) => r.includes("unicode")), []);
});

test("unicode integrity (the 32023R0956 bug): a curly quote the archived source does not have is caught in a claim span AND in authored prose", () => {
  const span = "(the ‘CBAM’) to address greenhouse gas emissions";
  const p = withFact(span, R0956.replace("'CBAM'", "‘CBAM’"), R0956);
  const rs = preflight(p, ok).failures;
  assert.ok(rs.some((f) => f.reason === "fact_span_matches_payload_only_not_archive" || f.reason === "fact_span_unicode_substitution"), "the claim span");
  assert.ok(rs.some((f) => f.reason === "prose_unicode_substitution" && f.location === "full_brief"), "the prose in full_brief");
  const straight = withFact("(the 'CBAM') to address greenhouse gas emissions", R0956, R0956);
  assert.deepEqual(reasons(straight).filter((r) => r.includes("unicode")), []);
});

test("INV-296: capture completeness: a missing fetched length, a capture longer than fetched, one under the 98% floor, and the in-between mismatch are each named; within 50 characters is clean", () => {
  const at = (contentLen: number, fetched: number | undefined) => {
    const p = clone();
    p.search_results[0]!.result_content = "x".repeat(contentLen);
    if (fetched === undefined) delete (p.search_results[0] as { fetched_length?: number }).fetched_length;
    else p.search_results[0]!.fetched_length = fetched;
    p.claims = [];
    return preflight(p, ok).failures.filter((f) => String(f.reason).startsWith("capture_") || f.reason === "missing_fetched_length").map((f) => f.reason);
  };
  assert.deepEqual(at(1000, undefined), ["missing_fetched_length"]);
  assert.deepEqual(at(1000, 1000), []);
  assert.deepEqual(at(1000, 1049), [], "49 short is within the tolerance");
  assert.deepEqual(at(1000, 950), [], "50 long is within the tolerance");
  assert.deepEqual(at(1000, 900), ["capture_length_exceeds_fetched"]);
  assert.deepEqual(at(1000, 1100), ["capture_incomplete"], "91% of the fetched document");
  assert.deepEqual(at(4900, 5000), ["capture_length_mismatch"], "98% retained but 100 characters off");
});

test("record purity: only FACT and GAP claims, and every FACT span must be inside the extractive full_brief", () => {
  const a = clone();
  a.claims.push({ section_key: "record_facts", claim_kind: "ANALYSIS", claim_text: "Per the workspace's reading: x", source_span: null, source_url: null, slot_key: "x" } as never);
  assert.ok(reasons(a).includes("kit:record_grade_forbidden_claim_kind"));
  const b = clone();
  b.item.full_brief = "A brief that quotes nothing";
  assert.ok(reasons(b).includes("kit:record_grade_full_brief_not_extractive"));
  const c = clone();
  c.claims[0]!.section_key = "no_such_section" as never;
  assert.ok(reasons(c).includes("kit:claim_references_unknown_section_key"));
});

test("record_hollow is criterion 5 (so the hold reads validation_failed:5:record_hollow): a title-only or all-GAP record is refused, a registered series is exempt, research gets no exemption", () => {
  const hollow = clone();
  hollow.claims = hollow.claims.filter((c) => c.claim_kind === "GAP");
  hollow.item.full_brief = "*Catalogue record*";
  assert.ok(reasons(hollow).includes("5:record_hollow"));
  const titleOnly = clone();
  titleOnly.claims = [{ section_key: "identity", claim_kind: "FACT", claim_text: "[title] Regulation 2023/9999", source_span: "Regulation 2023/9999", source_url: null, slot_key: "title" }];
  titleOnly.item.full_brief = "Regulation 2023/9999";
  assert.ok(reasons(titleOnly).includes("5:record_hollow"));
  const series = structuredClone(hollow);
  series.item.item_type = "market_signal";
  series.item.instrument_identifier = "oil_bulletin_diesel";
  assert.ok(!reasons(series).includes("5:record_hollow"), "a registered series key is exempt (mechanical registry lookup)");
  series.item.instrument_identifier = "made_up_key";
  assert.ok(reasons(series).includes("5:record_hollow"), "an unregistered key is not");
  const research = structuredClone(hollow);
  research.item.item_type = "research_finding";
  research.item.instrument_identifier = "oil_bulletin_diesel";
  assert.ok(reasons(research).includes("5:record_hollow"), "research records get no exemption");
});

test("INV-294: a record payload needs its own on_vertical screen verdict with a basis and a known provenance; ambiguous or absent never passes", () => {
  const none = clone();
  none.screen = null;
  assert.ok(reasons(none).includes("kit:screen_verdict_missing"));
  const noBasis = clone();
  noBasis.screen = { verdict: "on_vertical", provenance: "rule", basis: "  " };
  assert.ok(reasons(noBasis).includes("kit:screen_verdict_missing"));
  const badProvenance = clone();
  badProvenance.screen = { verdict: "on_vertical", provenance: "guess" as never, basis: "x" };
  assert.ok(reasons(badProvenance).includes("kit:screen_verdict_missing"));
  for (const verdict of ["ambiguous", "off_vertical"] as const) {
    const p = clone();
    p.screen = { verdict, provenance: "rule", basis: "x" };
    assert.ok(reasons(p).includes("kit:screen_verdict_not_on_vertical"), verdict);
  }
  const registry = clone();
  registry.screen = { verdict: "on_vertical", provenance: "registry", basis: "the source's registry role" };
  assert.deepEqual(reasons(registry), []);
  const brief = clone();
  brief.item.grade = "brief";
  brief.screen = null;
  assert.deepEqual(reasons(brief), [], "the record checks are for the record tier; a brief-grade payload has its own provenance path");
});

test("tag presence is visible and never blocks: each empty signature field and the all-empty case are named", () => {
  const p = clone();
  assert.equal(tagPresence(p).length, 4);
  p.item.topic_tags = ["freight"];
  p.item.operational_scenario_tags = ["x"];
  assert.deepEqual(tagPresence(p).map((w) => w.field), ["compliance_object_tags"]);
  p.item.compliance_object_tags = ["y"];
  assert.deepEqual(tagPresence(p), []);
});
