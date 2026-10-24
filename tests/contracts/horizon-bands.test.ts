// The band table the assessment code implements (src/features/research/model/assess.ts bandForDate: NOW up to 2 years, NEAR to 5, MID to 10, FAR beyond) is the one the theme horizons and the assessment
// stance rules are built on. The band is derived here from assess.ts itself at the boundary years, so a data file that drifts from the code is red.
import assert from "node:assert/strict";
import { test } from "node:test";

import horizonsJson from "@/core/themes/data/horizons.json";
import { assessItem } from "@/features/research/model/assess";
import stanceJson from "@/features/research/model/data/assessment-stance.json";

const NOW = new Date("2026-10-24T00:00:00Z");
const DAY = 86_400_000;
const YEARS = [1, 2, 3, 5, 6, 10, 11];

/** The band assess.ts gives a statutory event dated `years` after now (the code's own year length, 365.25 days). */
function assessBand(years: number): string {
  const event_date = new Date(NOW.getTime() + years * 365.25 * DAY).toISOString();
  const horizon = assessItem({ id: "x", text: "", sourceTier: null, citationCount: null, entityId: null, forwardEvents: [{ id: "e", event_date, obligation_text: "CBAM definitive period applies", source_citation: null }] }, { now: NOW }).horizon;
  assert.ok(horizon, `no horizon at ${years} years`);
  return horizon.band;
}
const upTo = <T extends { toYears: number | null }>(rows: readonly T[], years: number): T | undefined => rows.find((r) => r.toYears === null || years <= r.toYears);

test("horizons.json carries the band-to-years table assess.ts implements, and every theme token sits inside exactly one band", () => {
  const derived = YEARS.map((y) => [y, assessBand(y)] as const);
  assert.deepEqual(derived, [[1, "NOW"], [2, "NOW"], [3, "NEAR"], [5, "NEAR"], [6, "MID"], [10, "MID"], [11, "FAR"]], "assess.ts changed its bands: the data files must follow");
  for (const [y, band] of derived) {
    assert.equal(upTo(horizonsJson.bands, y)?.code, band, `horizons.json band at ${y} years`);
    assert.equal(upTo(horizonsJson.tokens, y)?.band, band, `horizons.json token at ${y} years sits in ${band}`);
  }
  assert.deepEqual(horizonsJson.bands.map((b) => b.code), ["NOW", "NEAR", "MID", "FAR"]);
});

test("assessment-stance.json states each rule's horizon as the band the rule is for, and covers every band assess.ts can give", () => {
  const bands = new Set(YEARS.map(assessBand));
  assert.deepEqual([...stanceJson.horizons].sort(), [...bands].sort());
  for (const band of bands) assert.ok(stanceJson.rules.some((r) => "band" in r && r.band === band), `a rule for ${band}`);
  for (const r of stanceJson.rules) if ("band" in r) assert.equal(r.horizon, r.band, `a ${r.band} rule names the ${r.band} horizon`);
});
