import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BRIEF_EXTRA_FIELDS, BRIEF_FIELDS, COMPLIANCE_OBJECTS, CONTRACT_VERSION, crossLinkClaimSources, deriveTimeline, extractRecommendedActions, extractSections, harvestTimeline, parseRegulationSections, renderAuthorInstruction,
  TOPIC_TAGS, validateClaimRecords, validateMetadata,
} from "@/core/brief";
import { bankCandidate } from "@/core/brief/vocab";
import { assertNoInternalMarkers, checkBriefContent, findInternalMarkers, parseNewSources, stripClaimLedgerBlocks } from "@/core/brief/sections";
import { buildTimelineRows, derivedTimelineRow, isDerivedConsistent, parseRecurringRule, parseTimeline, toIsoDate } from "@/core/brief/timeline";

import { marketSignalBody, metadata, SOURCE } from "./fixtures.ts";

const NOW = new Date("2026-10-15T12:00:00Z");
const verdict = (over: Record<string, unknown>, opts: { adopted?: never } = {}) => validateMetadata(metadata(over), { now: NOW, ...opts });
const errorsOf = (over: Record<string, unknown>): string[] => {
  const r = verdict(over);
  return r.ok ? [] : r.errors;
};

test("the contract is ONE field table: 26 fields plus the 2 extras; the instruction text is rendered from it, so no count can drift (B-0221, B-1004)", () => {
  assert.equal(BRIEF_FIELDS.length, 26);
  assert.equal(BRIEF_EXTRA_FIELDS.length, 2);
  const text = renderAuthorInstruction();
  assert.match(text, new RegExp(`writes ${BRIEF_FIELDS.length} fields`));
  assert.match(text, new RegExp(`other ${BRIEF_FIELDS.length - 1} fields`));
  assert.match(text, new RegExp(`exactly ${COMPLIANCE_OBJECTS.length} values`), "the closed vocabulary count is the table's, not 18");
  for (const f of [...BRIEF_FIELDS, ...BRIEF_EXTRA_FIELDS]) assert.ok(text.includes(f.name), `the instruction names ${f.name}`);
  for (const c of COMPLIANCE_OBJECTS) assert.ok(text.includes(c), `the instruction lists ${c}`);
  assert.equal(CONTRACT_VERSION, "2026-09-11");
  assert.ok(renderAuthorInstruction({ compliance_object: [{ key: "adopted-widget" }] }).includes("adopted-widget"), "an adopted term reaches the instruction");
  assert.doesNotMatch(text, /sk-ant|claude-(?:opus|sonnet|haiku)/i);
  assert.equal(COMPLIANCE_OBJECTS.length, 19);
  assert.equal(TOPIC_TAGS.length, 7);
});

test("INV-159: metadata is written only when it validates against the contract", () => {
  assert.equal(verdict({}).ok, true);
  assert.match(errorsOf({ severity: "CATASTROPHIC" }).join("|"), /Invalid severity/);
  assert.match(errorsOf({ priority: "LOW" }).join("|"), /locked mapping/, "severity and priority are locked together");
  assert.match(errorsOf({ topic_tags: ["emissions", "fuels", "transport", "reporting"] }).join("|"), /exceeds 3/);
  assert.match(errorsOf({ topic_tags: ["nope"] }).join("|"), /out-of-vocabulary/);
  assert.match(errorsOf({ theme: "fuels_saf" }).join("|"), /research_summary/, "theme only on research_summary");
  assert.match(errorsOf({ format_type: "regulatory_fact_document", signal_band: "price" }).join("|"), /market_signal_brief/, "signal_band only on market_signal_brief");
  assert.match(errorsOf({ trajectory_points: { points: [{ date: "2026-01-01", value: 1 }] } }).join("|"), /signal_band === 'price'/, "trajectory only with a price band");
  assert.match(errorsOf({ sources_used: ["not-a-uuid"] }).join("|"), /non-UUID/);
  const five = COMPLIANCE_OBJECTS.slice(0, 5);
  const capped = verdict({ compliance_object_tags: five });
  assert.equal(capped.ok, true);
  if (capped.ok) {
    assert.equal(capped.value.compliance_object_tags.length, 4, "at most 4 compliance objects are held");
    assert.ok(capped.warnings.some((w) => w.includes("past the cap of 4")), "the dropped one is reported, not silent");
  }
  const missing = validateMetadata({}, { now: NOW });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.ok(missing.errors.length >= 10, "every missing required field is reported at once");
  assert.equal(validateMetadata(null, { now: NOW }).ok, false);
});

test("INV-159: last_regenerated_at is stamped from the clock, never trusted from the author; an out-of-vocabulary compliance object is banked, never dropped", () => {
  const r = validateMetadata(metadata({ last_regenerated_at: "1999-01-01", compliance_object_tags: [COMPLIANCE_OBJECTS[0], "made_up_object"] }), { now: NOW });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.last_regenerated_at, NOW.toISOString());
    assert.deepEqual(r.value.compliance_object_tags, [COMPLIANCE_OBJECTS[0]]);
    assert.ok(JSON.stringify(r.value.compliance_object_candidates).includes("made_up_object"));
  }
  assert.deepEqual(bankCandidate("theme", "totally new theme", undefined), { held: null, candidate: "totally new theme" });
  assert.deepEqual(bankCandidate("theme", "fuels_saf", undefined), { held: "fuels_saf", candidate: null });
  assert.equal(bankCandidate("theme", "emerging_topic", { theme: [{ key: "emerging topic" }] }).held, "emerging_topic", "an adopted theme is held");
  const long = verdict({ intersection_summary: "x".repeat(2500) });
  assert.equal(long.ok, true);
  if (long.ok) assert.equal(long.value.intersection_summary?.length, 2000);
});

test("claim ledger records: a FACT needs a span and a source, a source_id must be a UUID, each defect is reported with its index", () => {
  const r = validateClaimRecords([{ claim_kind: "FACT", claim_text: "x" }, { claim_kind: "BOGUS", claim_text: "x" }, { claim_kind: "ANALYSIS", claim_text: "ok" }, null, { claim_kind: "FACT", claim_text: "y", source_span: "s", source_id: "nope" }, { claim_kind: "FACT", claim_text: "z", source_span: "s" }]);
  assert.equal(r.claims.length, 1);
  assert.equal(r.errors.length, 5);
  assert.match(r.errors[0] ?? "", /missing source_span/);
  assert.equal(validateClaimRecords({}).errors[0], "claim ledger must be a JSON array");
  assert.equal(validateClaimRecords([{ claim_kind: "FACT", claim_text: "z", source_span: "s", source_id: SOURCE }]).claims.length, 1);
});

test("INV-156: attribution follows the capture that CONTAINS the span (same URL first, any row second, URL match last), with ONE case rule", () => {
  const claims = [{ section: "1", claim_text: "c", claim_kind: "FACT", source_span: "Operators shall report", source_id: null, source_url: "https://a.test/", slot_key: null }];
  const rows = [{ id: "r1", result_url: "https://a.test/", result_content: "unrelated text" }, { id: "r2", result_url: "https://b.test/", result_content: "OPERATORS SHALL REPORT annually" }];
  const [linked] = crossLinkClaimSources(claims as never, rows);
  assert.equal(linked?.search_result_id, "r2", "the capture containing the span wins over the row that merely shares the URL");
  assert.equal(linked?.source_url, "https://b.test/", "the claim is re-pointed to that row's URL");
  const [none] = crossLinkClaimSources([{ ...claims[0], source_span: "absent everywhere" }] as never, rows);
  assert.equal(none?.search_result_id, "r1", "only when no capture contains the span does the URL match apply");
  const [sameUrl] = crossLinkClaimSources([{ ...claims[0], source_span: "operators shall report" }] as never, [{ id: "x1", result_url: "https://a.test/", result_content: "Operators shall report" }, ...rows]);
  assert.equal(sameUrl?.search_result_id, "x1", "same URL first");
});

test("sections: extraction is by KEY from the contract's format (market_signal 8, conditional flags carried), and an unknown type or a bare body yields none", () => {
  const rows = extractSections(marketSignalBody(), "market_signal");
  assert.deepEqual(rows.map((r) => r.section_key), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.deepEqual(rows.filter((r) => r.is_conditional).map((r) => r.section_key), ["5", "6"]);
  assert.deepEqual(extractSections(marketSignalBody(), "bogus_type"), []);
  assert.equal(extractSections("no headings at all", "market_signal").length, 0);
  assert.equal(extractSections("## 1. Only one\n\ntext", "regulation").length, 1);
});

test("INV-092 / B-0272: an internal marker never reaches a stored body, and a fetch-failure explanation is not a brief", () => {
  assert.equal(findInternalMarkers("clean prose about CBAM").length, 0);
  assert.ok(findInternalMarkers("text <<<CLAIM_PROVENANCE_LEDGER [] CLAIM_PROVENANCE_LEDGER>>>").length >= 2);
  assert.ok(findInternalMarkers('prose {"claim_text": "this is a stray json object literal that is long enough to count"}').some((h) => h.id === "json-object-literal"));
  assert.throws(() => assertNoInternalMarkers("x <<< y", "the writer"), /internal_marker_in_body/);
  assert.equal(stripClaimLedgerBlocks("body\n<<<CLAIM_PROVENANCE_LEDGER\n[]\nCLAIM_PROVENANCE_LEDGER>>>"), "body");
  assert.equal(stripClaimLedgerBlocks("body <<<CLAIM_PROVENANCE_LEDGER never closed"), "body");
  assert.equal(checkBriefContent("Access denied: the source returned 403 for every request.").ok, false);
  assert.equal(checkBriefContent("The Regulation sets out annual reporting duties.").ok, true);
});

test("new sources table: rows are name, url and tier; a blocked row carries its reason", () => {
  const md = "## New Sources Identified\n\n| Source name | URL | Tier |\n|---|---|---|\n| **ICCT** | https://theicct.org/x | 4 |\n| Blocked Co | https://blocked.test/y | 5 | Cloudflare blocked |\n";
  const rows = parseNewSources(md);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.name, "ICCT");
  assert.equal(rows[0]?.tier_estimate, 4);
  assert.equal(rows[1]?.rejection_reason, "cloudflare_block");
  assert.deepEqual(parseNewSources("no table here"), []);
});

test("timeline: dates normalise with their precision, an unparseable token is skipped and reported, past rows are completed", () => {
  assert.deepEqual(toIsoDate("1 January 2027"), { iso: "2027-01-01", precision: "day" });
  assert.deepEqual(toIsoDate("March 2026"), { iso: "2026-03-01", precision: "month" });
  assert.deepEqual(toIsoDate("Q3 2027"), { iso: "2027-07-01", precision: "quarter" });
  assert.equal(toIsoDate("2026-13-45"), null);
  assert.equal(toIsoDate(null), null);
  const { rows, skipped } = buildTimelineRows([{ date: "garbage", label: "x", source: null }, { date: "2020-01-01", label: "past", source: null }, { date: "2030-05-05", label: "future", source: null }], "2026-10-15");
  assert.deepEqual(rows.map((r) => [r.label, r.is_completed]), [["past", true], ["future", false]]);
  assert.equal(skipped.length, 1);
  assert.equal(parseTimeline("- 1 January 2027: Rule enters into force.\n- 30 April 2028: first report due.").length, 2);
  const h = harvestTimeline(marketSignalBody(), "market_signal", "2026-10-15");
  assert.equal(h.applicable, true);
  assert.deepEqual(h.rows.map((r) => r.milestone_date), ["2027-01-01", "2028-04-30"]);
  assert.equal(harvestTimeline(marketSignalBody(), "bogus", "2026-10-15").applicable, false);
});

test("ADR-030: a title-derived date is used only when it is verbatim in the item's own capture; a recurring rule and its derived date must agree", () => {
  const miss = deriveTimeline({ title: "Regulation (EU) 2023/1115 of 31 May 2023", capturedText: null } as never);
  assert.equal(miss.result, null);
  assert.equal(miss.attempts[0]?.outcome, "miss-not-in-capture");
  const hit = deriveTimeline({ title: "Regulation (EU) 2023/1115 of 31 May 2023", capturedText: "REGULATION (EU) 2023/1115 ... Done at Brussels, 31 May 2023. ".repeat(10) } as never);
  assert.equal(hit.result?.source, "title");
  assert.equal(derivedTimelineRow(hit.result as never, "2026-10-15").milestone_date, "2023-05-31");
  assert.deepEqual(parseRecurringRule("Operators shall report before 30 April of each year"), { kind: "annual", month: 4, day: 30 });
  assert.equal(isDerivedConsistent("Operators shall report before 30 April of each year", "30 April 2028"), true);
  assert.equal(isDerivedConsistent("Operators shall report before 30 April of each year", "1 May 2028"), false);
});

test("regulation detail parsers: section 3 is an action list, 14 a timeline, 15 a sources list with tiers; recommended actions need a concrete verb", () => {
  const reg = [
    "## 3. Issues Requiring Immediate Action", "", "- **ACTION REQUIRED:** Assess the exposure of the annual report by 30 April 2028.", "",
    "## 14. Confirmed Regulatory Timeline", "", "- 1 January 2027: Entry into force", "",
    "## 15. Sources", "", "- [Tier 1] EUR-Lex: https://eur-lex.europa.eu/x", "- [Tier 5] News: https://example-news.test/a",
  ].join("\n");
  const p = parseRegulationSections(reg);
  assert.equal(p["3"]?.kind, "action_list");
  assert.equal(p["14"]?.kind, "timeline");
  assert.equal(p["15"]?.kind, "sources_list");
  if (p["15"]?.kind === "sources_list") assert.deepEqual(p["15"].entries.map((e) => e.tier), [1, 5]);
  assert.deepEqual(parseRegulationSections(null), {});
  assert.ok(Array.isArray(extractRecommendedActions(reg, "regulation")));
  assert.deepEqual(extractRecommendedActions(null, "regulation"), []);
});
