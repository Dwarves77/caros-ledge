import assert from "node:assert/strict";
import { test } from "node:test";

import horizonsJson from "@/core/themes/data/horizons.json";
import { parseHorizons } from "@/core/themes/horizons";
import { themeAnalysisView, type MemberRow, type ThemeEventRow, type ThemeRow } from "@/core/themes";
import { selectAssessmentView, type AssessmentRow } from "@/features/research/model/assessment-view";

const AS_OF = "2026-10-24T00:00:00Z";
const THEME: ThemeRow = { id: "theme-1", member_ids: ["reg", "ops", "res", "bare"], surfaces: ["regulations", "operations", "research"], pivots: [{ id: "reg" }, { id: "res" }] };
const MEMBERS: MemberRow[] = [
  { id: "reg", legacy_id: "reg", title: "Packaging mandate", item_type: "regulation", domain: 1 },
  { id: "ops", legacy_id: "ops", title: "Sorting run", item_type: "regional_data", domain: 3, compliance_deadline: "2028-09-01" },
  { id: "res", legacy_id: "res", title: "Solid-state battery research", item_type: "research_finding", domain: 7, horizon_band: "MID" },
  { id: "bare", legacy_id: "bare", title: "No dates anywhere", item_type: "market_signal", domain: 4 },
];
const EVENTS: ThemeEventRow[] = [
  { id: "ev-2", intelligence_item_id: "reg", event_date: "2027-09-01", date_precision: "day", event_kind: "compliance_deadline" },
  { id: "ev-1", intelligence_item_id: "reg", event_date: "2027-01-01", date_precision: "day", event_kind: "entry_into_force" },
];

test("the forward outlook is structure: horizon tokens, member ids, surfaces, pivots and the dated events that place them", () => {
  const view = themeAnalysisView({ itemId: "reg", surface: "regulations", themes: [THEME], briefs: [], members: MEMBERS, events: EVENTS, asOfIso: AS_OF });
  assert.deepEqual(view?.forwardOutlook, {
    horizons: [
      {
        horizon: "0-6m",
        memberIds: ["reg"],
        surfaces: ["regulations"],
        pivotIds: ["reg"],
        triggers: [
          { eventId: "ev-1", itemId: "reg", date: "2027-01-01", precision: "day", kind: "entry_into_force" },
          { eventId: "ev-2", itemId: "reg", date: "2027-09-01", precision: "day", kind: "compliance_deadline" },
        ],
      },
      { horizon: "18-36m", memberIds: ["ops"], surfaces: ["operations"], pivotIds: [], triggers: [] },
      { horizon: "MID", memberIds: ["res"], surfaces: ["research"], pivotIds: ["res"], triggers: [] },
      { horizon: "unplaced", memberIds: ["bare"], surfaces: ["market"], pivotIds: [], triggers: [] },
    ],
  });
});

test("a member with no recorded horizon, event or deadline is unplaced, never placed by its page", () => {
  const theme: ThemeRow = { id: "t", member_ids: ["a", "b"], surfaces: ["operations", "research"] };
  const members: MemberRow[] = [
    { id: "a", legacy_id: "a", title: "A", item_type: "regional_data", domain: 3 },
    { id: "b", legacy_id: "b", title: "B", item_type: "research_finding", domain: 7 },
  ];
  const view = themeAnalysisView({ itemId: "a", surface: "operations", themes: [theme], briefs: [], members, asOfIso: AS_OF });
  assert.deepEqual(view?.forwardOutlook.horizons.map((h) => [h.horizon, h.memberIds]), [["unplaced", ["a", "b"]]]);
});

test("the window edges come from the data file, counted in months of 365.25/12 days from asOf", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const theme: ThemeRow = { id: "t", member_ids: ids };
  const members: MemberRow[] = ids.map((id) => ({ id, legacy_id: id, title: id, item_type: "regulation", domain: 1, ...(id === "e" ? { horizon_band: "FAR" } : {}) }));
  const day = (id: string, event_date: string): ThemeEventRow => ({ id: `ev-${id}`, intelligence_item_id: id, event_date, date_precision: "day", event_kind: "compliance_deadline" });
  const events = [day("a", "2027-04-24"), day("b", "2027-04-26"), day("c", "2029-10-23"), day("d", "2029-10-24")];
  const view = themeAnalysisView({ itemId: "a", surface: "regulations", themes: [theme], briefs: [], members, events, asOfIso: AS_OF });
  assert.deepEqual(view?.forwardOutlook.horizons.map((h) => [h.horizon, h.memberIds]), [["0-6m", ["a"]], ["6-18m", ["b"]], ["18-36m", ["c"]], ["3-5y", ["d"]], ["FAR", ["e"]]]);
});

test("horizons.json missing a key, or naming a token outside its own lists, is refused at load", () => {
  for (const key of Object.keys(horizonsJson)) {
    const without = Object.fromEntries(Object.entries(horizonsJson).filter(([k]) => k !== key));
    assert.throws(() => parseHorizons(without), `a file without ${key} must be refused`);
  }
  assert.throws(() => parseHorizons({ ...horizonsJson, windows: horizonsJson.windows.map((w) => (w.token === "18-36m" ? { ...w, bands: ["NOW"] } : w)) }), "a window must list exactly the bands its months overlap");
  assert.throws(() => parseHorizons({ ...horizonsJson, windows: horizonsJson.windows.map((w) => (w.token === "3-5y" ? { ...w, bands: ["NEAR", "MID"] } : w)) }), "a window cannot list a band it does not overlap");
  assert.doesNotThrow(() => parseHorizons(horizonsJson));
});

test("assessment stance: a stance token and a horizon token from the rules file, null for a refusal", () => {
  const base: AssessmentRow = {
    id: "a1", item_id: "i1", supersedes: null, is_current: true, lifecycle_state: null,
    technical_maturity_low: null, technical_maturity_high: null, technical_maturity_method: null,
    commercial_maturity_low: null, commercial_maturity_high: null, commercial_maturity_method: null,
    horizon_kind: null, horizon_band: null, horizon_rule: null, horizon_confidence: null, horizon_trigger_note: null,
    refusal_reason: null, credibility_evidence_score: null, credibility_authority_score: null, status_token: "CONFIRMED", computed_at: "2026-10-21T00:00:00Z",
  };
  const outlook = (patch: Partial<AssessmentRow>) => selectAssessmentView({ ...base, ...patch })?.forwardOutlook;
  assert.deepEqual(outlook({ horizon_band: "NOW", horizon_kind: "obligation" }), { stance: "act_today", horizon: "NOW" });
  assert.deepEqual(outlook({ horizon_band: "NOW", horizon_kind: "availability", technical_maturity_high: 6, commercial_maturity_high: 2 }), { stance: "act_today", horizon: "NOW" });
  assert.deepEqual(outlook({ horizon_band: "NEAR", horizon_kind: "obligation" }), { stance: "act_today", horizon: "NEAR" });
  assert.deepEqual(outlook({ horizon_band: "NEAR", horizon_kind: "availability", technical_maturity_high: 7 }), { stance: "wait_stage", horizon: "NEAR" });
  assert.deepEqual(outlook({ horizon_band: "MID" }), { stance: "wait_stage", horizon: "MID" });
  assert.deepEqual(outlook({ horizon_band: "FAR" }), { stance: "wait_stage", horizon: "FAR" });
  assert.deepEqual(outlook({ technical_maturity_high: 9, commercial_maturity_high: 5 }), { stance: "act_today", horizon: "NOW" });
  assert.equal(outlook({ technical_maturity_high: 5 }), null, "no band and no mature corridor classifies nothing");
  assert.equal(outlook({ refusal_reason: "no_dated_basis" }), null);
});
