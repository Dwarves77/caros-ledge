// R2d S1/S5, Research: surfaces:4 (an entity in a string literal), surfaces:5 ("Not forecastable: not forecastable: ... spec-03"), surfaces:19 (HIGH shown as "Cost alert"), surfaces:20 (raw type token), surfaces:68 (raw band token),
// surfaces:69 (eleven fixed "needs" lines). Each case first reproduces the register's wrong output.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";

import { assessItem, toRow } from "@/features/research/model/assess";
import { refusalText, selectAssessmentView, type AssessmentRow } from "@/features/research/model/assessment-view";
import { AssessmentCard } from "@/features/research/ui/AssessmentRail";
import { CredibilityChips } from "@/features/research/ui/CredibilityChips";
import { itemTypeLabel } from "@/core/lists";

import { renderApp, textOf } from "../_support/render.ts";

const NOW = new Date("2026-10-19T00:00:00Z");
const row = (over: Partial<AssessmentRow> = {}): AssessmentRow => ({
  id: "a1", item_id: "i1", supersedes: null, is_current: true, lifecycle_state: null, technical_maturity_low: null, technical_maturity_high: null, technical_maturity_method: null, commercial_maturity_low: null, commercial_maturity_high: null, commercial_maturity_method: null,
  horizon_kind: null, horizon_band: null, horizon_rule: null, horizon_confidence: null, horizon_trigger_note: null, refusal_reason: null, credibility_evidence_score: null, credibility_authority_score: null, status_token: "HYPOTHESIS", computed_at: "2026-10-18T00:00:00Z", ...over,
});
const draw = (el: ReturnType<typeof createElement>) => textOf(renderApp(el));

test("surfaces:5 the producer writes a reason code and no prose; the card draws exactly one 'Not forecastable' with one sentence and names no specification", () => {
  const refused = assessItem({ id: "i1", text: "A short note with no dates.", sourceTier: 3, citationCount: null, forwardEvents: [], entityId: null }, { now: NOW });
  assert.equal(refused.refusalReason, "no_dated_basis");
  const stored = toRow(refused);
  assert.doesNotMatch(String(stored.refusal_reason), /\s|spec/);
  const view = selectAssessmentView(row({ refusal_reason: stored.refusal_reason as string }));
  const text = draw(createElement(AssessmentCard, { assessment: view, failed: false }));
  assert.equal((text.match(/Not forecastable/gi) ?? []).length, 1, text);
  assert.doesNotMatch(text, /spec-?\d|section 6|mandatory refusal/i);
  assert.match(text, /no dated statutory instrument/);
});

test("surfaces:5 the old stored prose (the reproduced wrong output) never reaches the customer: any stored refusal text that is not a known code reads as the one generic sentence", () => {
  const legacy = "not forecastable: no dated statutory instrument, no named institutional roadmap date, and no technical-maturity corridor to prior from (spec-03 section 6's mandatory refusal state).";
  assert.equal(refusalText(legacy), refusalText("something_else"));
  const text = draw(createElement(AssessmentCard, { assessment: selectAssessmentView(row({ refusal_reason: legacy })), failed: false }));
  assert.equal((text.match(/Not forecastable/gi) ?? []).length, 1);
  assert.doesNotMatch(text, /spec-?\d|mandatory/i);
});

test("surfaces:5 the maturity method is a code in the row and a plain sentence on the card: no specification reference is stored or drawn", () => {
  const a = assessItem({ id: "i1", text: "The pilot is at TRL 7 and in demonstration.", sourceTier: 3, citationCount: null, forwardEvents: [], entityId: null }, { now: NOW });
  assert.ok(a.technicalMaturity, "the fixture has a corridor");
  assert.doesNotMatch(String(a.technicalMaturity?.method), /spec|\s/);
  const text = draw(createElement(AssessmentCard, { assessment: selectAssessmentView(row({ technical_maturity_low: 7, technical_maturity_high: 7, technical_maturity_method: a.technicalMaturity?.method ?? null, horizon_band: "NEAR", horizon_rule: "R4", horizon_kind: "availability", horizon_confidence: "low" })), failed: false }));
  assert.match(text, /TRL 7/);
  assert.doesNotMatch(text, /spec-?\d/);
  const legacyMethod = draw(createElement(AssessmentCard, { assessment: selectAssessmentView(row({ technical_maturity_low: 7, technical_maturity_high: 7, technical_maturity_method: "read from the item's own recorded text against the IEA-extended TRL 1-11 ladder (spec-03 section 2)", horizon_band: "NEAR", horizon_rule: "R4", horizon_kind: "availability" })), failed: false }));
  assert.doesNotMatch(legacyMethod, /spec-?\d/);
});

test("surfaces:20 a row's type chip carries the type's word, never the stored code or the placeholder 'uncertain'", () => {
  assert.equal(itemTypeLabel("research_finding"), "Research finding");
  assert.equal(itemTypeLabel("uncertain"), null);
  assert.equal(itemTypeLabel(undefined), null);
  assert.equal(itemTypeLabel("market_signal"), "Market signal");
  assert.doesNotMatch(itemTypeLabel("regional_data") ?? "", /_/);
});

test("surfaces:69 the credibility chips draw the lines that have data and no fixed 'needs' line: with nothing recorded the legend names the two scores; with one recorded the other is absent, not a placeholder", () => {
  const legend = draw(createElement(CredibilityChips));
  assert.doesNotMatch(legend, /needs/i);
  assert.match(legend, /Evidence × agreement/);
  assert.match(legend, /Source authority/);
  const evidenceOnly = draw(createElement(CredibilityChips, { assessment: selectAssessmentView(row({ credibility_evidence_score: "medium" })) }));
  assert.match(evidenceOnly, /Evidence × agreement: Medium/);
  assert.doesNotMatch(evidenceOnly, /needs|Source authority/i, evidenceOnly);
  const both = draw(createElement(CredibilityChips, { assessment: selectAssessmentView(row({ credibility_evidence_score: "high", credibility_authority_score: { highAuthorityIndependent: 2, medium: 1, vendorFlagged: 0 } })) }));
  assert.match(both, /Evidence × agreement: High/);
  assert.match(both, /Source authority: 2 high-authority · 1 medium · 0 vendor-flagged/);
  assert.doesNotMatch(both, /needs/i);
});

test("surfaces:4 no customer string in the research or operations detail carries an HTML entity in a string literal", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["src/features/research/ui/ResearchDetail.tsx", "src/features/operations/ui/OperationsDetail.tsx"]) {
    const text = readFileSync(f, "utf8");
    const literals = [...text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1] as string);
    assert.deepEqual(literals.filter((l) => /&[a-z]{2,6};|&#\d+;/.test(l)), [], f);
  }
});
