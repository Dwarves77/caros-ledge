import assert from "node:assert/strict";
import { test } from "node:test";

import { themeAnalysisView, type MemberRow, type ThemeRow } from "@/core/themes";
import { selectAssessmentView, type AssessmentRow } from "@/features/research/model/assessment-view";

test("ThemeForwardOutlook: synthesizes 'Act/Invest Today' for immediate 0–12m horizons", () => {
  const themes: ThemeRow[] = [
    {
      id: "theme-1",
      member_ids: ["item-reg", "item-ops"],
      surfaces: ["regulations", "operations"],
      pivots: [{ id: "item-reg" }],
    },
  ];
  const members: MemberRow[] = [
    { id: "item-reg", legacy_id: "reg", title: "Packaging Mandate", item_type: "regulation", domain: 1, priority: "CRITICAL" },
    { id: "item-ops", legacy_id: "ops", title: "Warehouse Sorting Run", item_type: "regional_data", domain: 3 },
  ];

  const view = themeAnalysisView({
    itemId: "item-reg",
    surface: "regulations",
    themes,
    briefs: [],
    members,
    asOfIso: "2026-10-21",
  });

  assert.ok(view);
  const outlook = view.forwardOutlook;
  assert.equal(outlook.stance, "Act/Invest Today");
  assert.match(outlook.headline, /Act\/Invest Today/);
  assert.match(outlook.headline, /0–12m/);
  assert.ok(outlook.horizons.some((h) => h.horizon === "0–12m"));
  assert.ok(outlook.crossSurfaceHandoff);
  assert.match(outlook.crossSurfaceHandoff, /Statutory mandate on Regulations triggers direct operational execution/);
});

test("ThemeForwardOutlook: synthesizes 'Wait/Stage' when all members are on 2–5y research horizons", () => {
  const themes: ThemeRow[] = [
    {
      id: "theme-2",
      member_ids: ["item-res1", "item-res2"],
      surfaces: ["research"],
      pivots: [{ id: "item-res1" }],
    },
  ];
  const members: MemberRow[] = [
    { id: "item-res1", legacy_id: "res1", title: "Solid-state battery research", item_type: "research_finding", domain: 7, horizon: "2–5y" },
    { id: "item-res2", legacy_id: "res2", title: "Synthetic e-methanol fuel synthesis", item_type: "research_finding", domain: 7, horizon: "2–5y" },
  ];

  const view = themeAnalysisView({
    itemId: "item-res1",
    surface: "research",
    themes,
    briefs: [],
    members,
    asOfIso: "2026-10-21",
  });

  assert.ok(view);
  const outlook = view.forwardOutlook;
  assert.equal(outlook.stance, "Wait/Stage");
  assert.match(outlook.headline, /Wait\/Stage/);
  assert.match(outlook.headline, /2–5y/);
  assert.match(outlook.guidance, /No immediate 0–12m statutory penalties/);
  assert.ok(outlook.horizons.some((h) => h.horizon === "2–5y"));
});

test("ThemeForwardOutlook: cross-surface handoffs reflect interacting intelligence surfaces", () => {
  const themeRegMarket: ThemeRow = { id: "t-rm", member_ids: ["r1", "m1"], surfaces: ["regulations", "market"], pivots: [{ id: "r1" }] };
  const membersRM: MemberRow[] = [
    { id: "r1", legacy_id: "r1", title: "EU ETS maritime expansion", item_type: "regulation", domain: 1 },
    { id: "m1", legacy_id: "m1", title: "Carbon EUA spot price", item_type: "market_signal", domain: 4 },
  ];
  const viewRM = themeAnalysisView({
    itemId: "r1",
    surface: "regulations",
    themes: [themeRegMarket],
    briefs: [],
    members: membersRM,
  });
  assert.match(viewRM?.forwardOutlook.crossSurfaceHandoff ?? "", /Regulatory penalty thresholds and mandate timelines directly drive market cost mechanisms/);

  const themeResOps: ThemeRow = { id: "t-ro", member_ids: ["res1", "ops1"], surfaces: ["research", "operations"], pivots: [{ id: "ops1" }] };
  const membersRO: MemberRow[] = [
    { id: "res1", legacy_id: "res1", title: "Hydrogen fuel cell heavy truck trial", item_type: "research_finding", domain: 7 },
    { id: "ops1", legacy_id: "ops1", title: "Port hydrogen refueling hub", item_type: "regional_data", domain: 3 },
  ];
  const viewRO = themeAnalysisView({
    itemId: "ops1",
    surface: "operations",
    themes: [themeResOps],
    briefs: [],
    members: membersRO,
  });
  assert.match(viewRO?.forwardOutlook.crossSurfaceHandoff ?? "", /Research maturity corridors inform fleet technology trials/);
});

test("AssessmentForwardOutlook: synthesizes stance and horizon from horizon_band, kind, and maturity corridors", () => {
  const baseRow: AssessmentRow = {
    id: "a1",
    item_id: "i1",
    supersedes: null,
    is_current: true,
    lifecycle_state: null,
    technical_maturity_low: null,
    technical_maturity_high: null,
    technical_maturity_method: null,
    commercial_maturity_low: null,
    commercial_maturity_high: null,
    commercial_maturity_method: null,
    horizon_kind: null,
    horizon_band: null,
    horizon_rule: null,
    horizon_confidence: null,
    horizon_trigger_note: null,
    refusal_reason: null,
    credibility_evidence_score: null,
    credibility_authority_score: null,
    status_token: "CONFIRMED",
    computed_at: "2026-10-21T00:00:00Z",
  };

  // 1. NOW with obligation -> Act/Invest Today, 0–12m
  const vNowOblig = selectAssessmentView({ ...baseRow, horizon_band: "NOW", horizon_kind: "obligation", horizon_rule: "R1" });
  assert.deepEqual(vNowOblig?.forwardOutlook, {
    stance: "Act/Invest Today",
    horizon: "0–12m",
    guidance: "Immediate statutory obligation takes effect within 2 years. Ensure operational compliance systems and audit readiness are deployed today.",
  });

  // 2. NOW with mature tech & commercial -> Act/Invest Today, 0–12m
  const vNowMature = selectAssessmentView({ ...baseRow, horizon_band: "NOW", horizon_kind: "availability", horizon_rule: "R4", technical_maturity_high: 9, commercial_maturity_high: 5 });
  assert.deepEqual(vNowMature?.forwardOutlook, {
    stance: "Act/Invest Today",
    horizon: "0–12m",
    guidance: "Commercial-ready solution with high technical maturity available now. Deploy immediately into active operations or fleet procurement.",
  });

  // 3. NOW with early pilot tech -> Act/Invest Today, 1–2y
  const vNowEarly = selectAssessmentView({ ...baseRow, horizon_band: "NOW", horizon_kind: "availability", horizon_rule: "R4", technical_maturity_high: 6, commercial_maturity_high: 2 });
  assert.deepEqual(vNowEarly?.forwardOutlook, {
    stance: "Act/Invest Today",
    horizon: "1–2y",
    guidance: "Near-term availability window. Initiate pilot demonstration and infrastructure staging today to de-risk full adoption.",
  });

  // 4. NEAR with obligation -> Act/Invest Today, 1–2y
  const vNearOblig = selectAssessmentView({ ...baseRow, horizon_band: "NEAR", horizon_kind: "obligation", horizon_rule: "R1" });
  assert.deepEqual(vNearOblig?.forwardOutlook, {
    stance: "Act/Invest Today",
    horizon: "1–2y",
    guidance: "Upcoming statutory mandate within 2 to 5 years. Initiate capital budgeting, vendor qualification, and trial runs ahead of enforcement.",
  });

  // 5. NEAR with demonstration tech -> Wait/Stage, 2–5y
  const vNearDemo = selectAssessmentView({ ...baseRow, horizon_band: "NEAR", horizon_kind: "availability", horizon_rule: "R4", technical_maturity_high: 7 });
  assert.deepEqual(vNearDemo?.forwardOutlook, {
    stance: "Wait/Stage",
    horizon: "2–5y",
    guidance: "Solution in demonstration or early commercialization. Stage procurement roadmaps and monitor commercial scale milestones before committing full capital.",
  });

  // 6. MID -> Wait/Stage, 2–5y
  const vMid = selectAssessmentView({ ...baseRow, horizon_band: "MID", horizon_kind: "availability", horizon_rule: "R3" });
  assert.deepEqual(vMid?.forwardOutlook, {
    stance: "Wait/Stage",
    horizon: "2–5y",
    guidance: "Medium-term transition horizon (5 to 10 years). Monitor institutional roadmaps and demonstration outcomes; do not commit operational capital today.",
  });

  // 7. FAR -> Wait/Stage, >5y
  const vFar = selectAssessmentView({ ...baseRow, horizon_band: "FAR", horizon_kind: "availability", horizon_rule: "R3" });
  assert.deepEqual(vFar?.forwardOutlook, {
    stance: "Wait/Stage",
    horizon: ">5y",
    guidance: "Long-term horizon beyond 10 years. Track fundamental research breakthroughs and policy signals without near-term operational changes.",
  });

  // 8. Refused assessment -> null outlook
  const vRefused = selectAssessmentView({ ...baseRow, refusal_reason: "no_dated_basis" });
  assert.equal(vRefused?.forwardOutlook, null);
});
