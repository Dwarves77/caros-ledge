// P2-12 Research: the pure models. The horizon cascade (INV-227: R1 anchors only on a dated event whose OWN text names the instrument), the TRL ladder (6-7 is reachable), the corridor labels (INV-228),
// the taxonomy (the last-mile theme is reachable, `now` is injected) and the signpost and history views.
import assert from "node:assert/strict";
import { test } from "node:test";

import { assessHorizon, assessItem, assessTechnicalMaturity, type AssessInput } from "@/features/research/model/assess";
import { corridorLabel, horizonMetaLabel, selectAssessmentView, selectAssessmentViewsByItemId, selectHistoryEntry, selectSignpostView, summarizePredicate, type AssessmentRow } from "@/features/research/model/assessment-view";
import { SEVERITY_COLUMN_TO_KEY, severityOf, themeOf, THEME_KEYS } from "@/features/research/model/taxonomy";

const NOW = new Date("2026-10-01T00:00:00Z");
const input = (o: Partial<AssessInput> = {}): AssessInput => ({ id: "item-1", text: "Hydrogen trucks.", sourceTier: 3, citationCount: null, forwardEvents: [], entityId: null, ...o });
const ev = (id: string, date: string | null, text: string, cite: string | null = null) => ({ id, event_date: date, obligation_text: text, source_citation: cite });

test("R1 anchors on the dated event whose OWN text names the statutory instrument, not on the first dated event (INV-227)", () => {
  const events = [ev("e-other", "2026-12-01", "Operators submit a report"), ev("e-law", "2028-03-01", "FuelEU phase-in begins")];
  const h = assessHorizon(input({ text: "FuelEU applies to ships", forwardEvents: events }), null, NOW);
  assert.deepEqual([h?.rule, h?.anchor?.eventId, h?.kind, h?.confidence], ["R1", "e-law", "obligation", "high"], "the unrelated earlier event is not the anchor");
  // The item text naming a law is not enough: no event names it, so R1 does not fire.
  assert.notEqual(assessHorizon(input({ text: "FuelEU applies to ships", forwardEvents: [ev("e1", "2027-01-01", "Operators submit a report")] }), { low: 8 }, NOW)?.rule, "R1");
  // An undated or unparseable statutory event cannot anchor.
  assert.notEqual(assessHorizon(input({ forwardEvents: [ev("e2", null, "FuelEU phase-in"), ev("e3", "not-a-date", "FuelEU phase-in")] }), { low: 8 }, NOW)?.rule, "R1");
});

test("R3, R4 and the refusal: a roadmap date is medium, a maturity prior is low and a hypothesis, nothing to band on is a stated refusal (INV-227)", () => {
  const r3 = assessItem(input({ forwardEvents: [ev("e", "2033-06-01", "deployment", "IEA roadmap")] }), { now: NOW });
  assert.deepEqual([r3.horizon?.rule, r3.horizon?.confidence, r3.statusToken], ["R3", "medium", "CONFIRMED"]);
  const r4 = assessItem(input({ text: "A demonstration pilot project." }), { now: NOW });
  assert.deepEqual([r4.horizon?.rule, r4.horizon?.confidence, r4.statusToken], ["R4", "low", "HYPOTHESIS"], "R4 confidence is forced low and never CONFIRMED");
  const none = assessItem(input({ text: "nothing forecastable" }), { now: NOW });
  assert.equal(none.horizon, null);
  assert.match(none.refusalReason ?? "", /not forecastable/);
});

test("a demonstration plant reads TRL 6-7 (the old ladder shadowed it with the 8-9 row); a demonstration alone still reads 8-9 (INV-228)", () => {
  const plant = assessTechnicalMaturity(input({ text: "Built as a demonstration plant for green hydrogen." }));
  assert.deepEqual([plant?.low, plant?.high], [6, 7]);
  const demo = assessTechnicalMaturity(input({ text: "Demonstrated at a pilot project." }));
  assert.deepEqual([demo?.low, demo?.high], [8, 9]);
  assert.equal(assessTechnicalMaturity(input({ text: "nothing about maturity" })), null, "no ladder phrase is no corridor, never a midpoint");
});

test("a corridor label is a point for a point and a span for a span; the horizon label is null for a refusal", () => {
  assert.equal(corridorLabel("TRL", 8, 8), "TRL 8");
  assert.equal(corridorLabel("CRI", 3, 4), "CRI 3-4");
  const row: AssessmentRow = {
    id: "a1", item_id: "i1", supersedes: null, is_current: true, lifecycle_state: null, technical_maturity_low: 8, technical_maturity_high: 8, technical_maturity_method: "m",
    commercial_maturity_low: null, commercial_maturity_high: null, commercial_maturity_method: null, horizon_kind: "obligation", horizon_band: "NEAR", horizon_rule: "R1", horizon_confidence: "high",
    horizon_trigger_note: "binds", refusal_reason: null, credibility_evidence_score: "robust", credibility_authority_score: { highAuthorityIndependent: 1, medium: 0, vendorFlagged: 0 }, status_token: "CONFIRMED", computed_at: "2026-10-01T00:00:00Z",
  };
  const v = selectAssessmentView(row);
  assert.deepEqual([v?.technical?.label, v?.commercial, v?.anchored, horizonMetaLabel(v)], ["TRL 8", null, true, "NEAR horizon"]);
  const refused = selectAssessmentView({ ...row, horizon_band: null, horizon_rule: null, horizon_kind: null, refusal_reason: "not forecastable: x" });
  assert.deepEqual([refused?.horizon, refused?.anchored, horizonMetaLabel(refused)], [null, false, null]);
  assert.equal(selectAssessmentView(null), null);
  assert.equal(selectAssessmentViewsByItemId([row, { ...row, id: "a2", item_id: "i2" }]).size, 2);
  assert.deepEqual([selectHistoryEntry(v!, false).technicalLabel, selectHistoryEntry(v!, true).isCurrent], ["TRL 8", true]);
});

test("a signpost names the watched entity or none (never its raw id); the predicate reads in customer words and an unknown op guesses nothing", () => {
  const row = { entity_id: "cl:signpost:aa", assessment_id: "a1", watches: "cl:instrument:bb", predicate: { op: "date_passed", field: "occurred_at", by: "2027-01-01", basis: "movement_by_date" }, direction: "confirms", fired_at: null };
  const named = selectSignpostView(row, () => "FuelEU Maritime");
  assert.deepEqual([named.watchesLabel, named.summary], ["FuelEU Maritime", "expects a recorded change on what it watches by 2027-01-01"]);
  assert.equal(selectSignpostView(row, () => null).watchesLabel, null);
  assert.doesNotMatch(named.summary, /occurred_at|movement_by_date/);
  assert.equal(summarizePredicate({ op: "teleport" }), "condition not recognised");
  assert.equal(summarizePredicate(null), "no condition recorded");
});

test("the theme of an item: the stored column first; the specific last-mile phrase is reachable (the old general emission rule shadowed it); no match is null, never a default", () => {
  assert.equal(themeOf({ theme: "fuels_saf", title: "anything" }), "fuels_saf");
  assert.equal(themeOf({ title: "Zero-emission cargo bays for urban delivery" }), "last_mile_electrification");
  assert.equal(themeOf({ title: "A study of port congestion" }), null);
  assert.equal(themeOf({ theme: "bogus", title: "A study of port congestion" }), null, "an unknown stored value is not a theme");
  assert.equal(THEME_KEYS.length, 7);
});

test("severity: the stored column wins across all 13 values; the text and recency fallbacks read the INJECTED clock; nothing stored and nothing recent is background", () => {
  assert.equal(Object.keys(SEVERITY_COLUMN_TO_KEY).length, 13);
  assert.equal(severityOf("x", null, "window_closing", NOW), "action");
  assert.equal(severityOf("a deadline to file", null, null, NOW), "action");
  assert.equal(severityOf("a surcharge", null, null, NOW), "cost");
  assert.equal(severityOf("plain", "2026-09-25", null, NOW), "monitor", "added within 14 days of the injected now");
  assert.equal(severityOf("plain", "2026-09-25", null, new Date("2027-01-01T00:00:00Z")), "background", "the same item, a later injected now");
  assert.equal(severityOf("plain", null, null, NOW), "background");
});
