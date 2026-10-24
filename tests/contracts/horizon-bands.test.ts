// The band table the assessment code implements (src/features/research/model/assess.ts bandForDate: NOW up to 2 years, NEAR to 5, MID to 10, FAR beyond) is the single source the theme windows' band lists
// and the assessment stance rules are built on. The band is derived here from assess.ts itself at the boundary years, so a data file that drifts from the code is red. The windows (0-6m, 6-18m, 18-36m, ...)
// are the product's own axis and need not nest inside a band.
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
const bandAt = (years: number): string | undefined => horizonsJson.bands.find((b) => b.toYears === null || years <= b.toYears)?.code;
const windowAt = (years: number) => horizonsJson.windows.find((w) => w.toMonths === null || years * 12 <= w.toMonths);

test("horizons.json carries the band-to-years table assess.ts implements, and every window lists the bands it overlaps", () => {
  const derived = YEARS.map((y) => [y, assessBand(y)] as const);
  assert.deepEqual(derived, [[1, "NOW"], [2, "NOW"], [3, "NEAR"], [5, "NEAR"], [6, "MID"], [10, "MID"], [11, "FAR"]], "assess.ts changed its bands: the data files must follow");
  for (const [y, band] of derived) {
    assert.equal(bandAt(y), band, `horizons.json band at ${y} years`);
    assert.ok(windowAt(y)?.bands.includes(band), `the window at ${y} years lists ${band}`);
  }
  assert.deepEqual(horizonsJson.windows.find((w) => w.token === "18-36m")?.bands, ["NOW", "NEAR"], "18-36m straddles the 2-year NOW line");
  assert.deepEqual(horizonsJson.windows.map((w) => w.token), ["0-6m", "6-18m", "18-36m", "3-5y", "5-10y", ">10y"]);
  assert.deepEqual(horizonsJson.bands.map((b) => b.code), ["NOW", "NEAR", "MID", "FAR"]);
});

test("assessment-stance.json states each rule's horizon as the band the rule is for, and covers every band assess.ts can give", () => {
  const bands = new Set(YEARS.map(assessBand));
  assert.deepEqual([...stanceJson.horizons].sort(), [...bands].sort());
  for (const band of bands) assert.ok(stanceJson.rules.some((r) => "band" in r && r.band === band), `a rule for ${band}`);
  for (const r of stanceJson.rules) if ("band" in r) assert.equal(r.horizon, r.band, `a ${r.band} rule names the ${r.band} horizon`);
});
