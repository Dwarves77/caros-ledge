// R2d S1 and S2, the values and defaults the registers reproduced: a subdivision shown as a raw code, an item with no jurisdiction labelled "Global", a missing observation status read as "Normal, reliable",
// 2026-02-30 accepted as a date, "-0.04" shown as "-0.0%", a future date read as "just now", a missing tier defaulted to 5, a malformed counts reply read as zeros, a missing priority read as Awareness. Each
// test names the register row and asserts the right outcome; the comment says what the old code answered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { makeEnvelope, formatDelta } from "@/core/contracts/envelope";
import { isoToDisplayLabel, jurisLabelOf, regionGroupOfIso } from "@/core/jurisdictions";
import { TIER1_REGIONS, TIER1, TIER2 } from "@/core/jurisdictions/tiers";
import { buildSupersessionRows } from "@/core/flywheel";
import { bandFromPriority, NEUTRAL_BAND, requirePriority } from "@/core/lists";
import { parseNewSources } from "@/core/brief/sections";
import { formatRelativeCompact } from "@/core/shared/dates";
import { readAggregates, readSurfaceCounts } from "@/features/lists";
import { baseResourceFields } from "@/features/lists/map-rows";

import { memoryDb } from "../_support/memory-db.ts";

test("core:41 every subdivision the tier table lists has a name: 'US-AL' was shown as 'US-AL, United States' for 35 states", () => {
  const codes = new Set<string>([...TIER1, ...TIER2, ...TIER1_REGIONS.flatMap((r) => r.jurisdictions.map((j) => j.iso))].filter((c) => c.includes("-")));
  const unnamed = [...codes].filter((c) => !/^[^,]+, [A-Z]/.test(isoToDisplayLabel(c)));
  assert.deepEqual(unnamed, [], "a subdivision without a name prints as a code");
  assert.equal(isoToDisplayLabel("US-AL"), "Alabama, United States");
  assert.equal(isoToDisplayLabel("DE"), "Germany");
  assert.equal(isoToDisplayLabel("US-ZZ"), "US-ZZ, United States", "a code no table names is shown as the code, never guessed");
});

test("core:88 an item that names no jurisdiction is not labelled with one, and the region group of a code comes from a table built once", () => {
  assert.equal(jurisLabelOf({}), "", "it was 'Global', which asserts a scope nothing stated");
  assert.equal(jurisLabelOf({ jurisdictionIso: ["DE", "FR"] }), "Germany · France");
  assert.equal(regionGroupOfIso("DE"), regionGroupOfIso("DE"));
  assert.equal(regionGroupOfIso("ZZ"), "");
});

test("core:78, 79 an envelope without an observation status states none (it claimed 'A', normal and reliable), and 2026-02-30 is not a date", () => {
  const base = { unit: "EUR/t", derivation: "observed", as_of: { event_date: "2026-09-01" }, value: 12 };
  assert.equal(makeEnvelope(base).obs_status, null);
  assert.equal(makeEnvelope({ ...base, obs_status: "A" }).obs_status, "A");
  assert.throws(() => makeEnvelope({ ...base, as_of: { event_date: "2026-02-30" } }), /as_of\.event_date must be an ISO date/);
  assert.doesNotThrow(() => makeEnvelope({ ...base, as_of: { event_date: "2026-02-28", ingested_at: "2026-02-28T10:00:00Z" } }));
});

test("core:80, 81 a change that rounds to zero has no sign, and a date ahead reads as ahead", () => {
  assert.equal(formatDelta(-0.04, "quantity"), "0.0%", "it was −0.0%");
  assert.equal(formatDelta(-0.06, "quantity"), "−0.1%");
  assert.equal(formatDelta(0.04, "ratio"), "0.0 pp");
  assert.equal(formatDelta(1.25, "ratio"), "+1.3 pp");
  const now = Date.parse("2026-10-20T12:00:00Z");
  assert.equal(formatRelativeCompact("2999-01-01T00:00:00Z", now).startsWith("in "), true, "it read 'just now'");
  assert.equal(formatRelativeCompact("2026-10-20T13:00:00Z", now), "in 1h");
  assert.equal(formatRelativeCompact("2026-10-20T11:00:00Z", now), "1h ago");
  assert.equal(formatRelativeCompact("2026-10-20T12:00:20Z", now), "just now");
});

test("flywheel:31 a row of the New Sources table that states no tier has none: the parser defaulted it to 5 (a fabricated rating)", () => {
  const md = "## New Sources Identified\n| Source | URL | Tier |\n| --- | --- | --- |\n| Agency A | https://a.example/x | 4 |\n| Agency B | https://b.example/y | |\n";
  const rows = parseNewSources(md);
  assert.deepEqual(rows.map((r) => [r.name, r.tier_estimate]), [["Agency A", 4], ["Agency B", null]]);
  assert.match(readFileSync("src/features/sources/growth.ts", "utf8"), /parseNewSources\(input\.brief\)/, "the source-growth pass reads the one parser");
  assert.doesNotMatch(readFileSync("src/features/sources/growth.ts", "utf8"), /function parseNewSourcesFromBrief/, "the second parser is gone");
});

test("surfaces:85 a counts reply with a field missing or not a number is a failed read, never a page of zeros", async () => {
  const full = { total_items: 9, by_priority: { HIGH: 2 }, by_status: { active: 9 }, by_jurisdiction: { EU: 4 }, total_jurisdictions: 1, last_updated_at: null };
  const read = (data: unknown) => readAggregates(memoryDb({}, { rpc: () => ({ data }) }).db, "org");
  assert.equal((await read(full))?.totalItems, 9);
  assert.deepEqual((await read(full))?.byPriority, { CRITICAL: 0, HIGH: 2, MODERATE: 0, LOW: 0 }, "a priority the database left out has no items");
  for (const [what, broken] of [["no total", { ...full, total_items: undefined }], ["a total that is text", { ...full, total_items: "nine" }], ["no priority tally", { ...full, by_priority: undefined }], ["a tally value that is not a number", { ...full, by_status: { active: "many" } }], ["no jurisdiction count", { ...full, total_jurisdictions: null }]] as const) {
    assert.equal(await read(broken), null, what);
  }
  const surface = await readSurfaceCounts(memoryDb({}, { rpc: () => ({ data: { ...full, by_severity: { cost_alert: 1 }, by_band: { price: 2 } } }) }).db, "org", "market");
  assert.deepEqual([surface?.bySeverity, surface?.byBand], [{ cost_alert: 1 }, { price: 2 }]);
  assert.equal(await readSurfaceCounts(memoryDb({}, { rpc: () => ({ data: full }) }).db, "org", "market"), null, "a surface reply with no severity or band tally is malformed");
});

test("surfaces:84 and flywheel:54 a priority the row does not hold is the neutral band, never Awareness, and a list row without a valid priority refuses to load", () => {
  assert.equal(bandFromPriority("LOW").key, "awareness");
  for (const none of [null, undefined, "", "nonsense"]) assert.equal(bandFromPriority(none), NEUTRAL_BAND, String(none));
  assert.notEqual(NEUTRAL_BAND.cssVar, bandFromPriority("LOW").cssVar);
  assert.equal(requirePriority("HIGH", "x"), "HIGH");
  assert.throws(() => requirePriority(null, "item a"), /item a carries no valid priority/);
  assert.throws(() => baseResourceFields({ id: "a", legacy_id: null, title: "T", added_date: null } as never), /carries no valid priority/, "the row mapper refuses a row with no priority instead of drawing it at some default");
  assert.equal(baseResourceFields({ id: "a", legacy_id: null, title: "T", added_date: null, priority: "LOW", effective_priority: "HIGH" } as never).priority, "HIGH", "the workspace's effective priority wins");
});

test("flywheel:14 a supersession whose other item the verified lookup does not hold has no row: no title from the raw id, no fabricated MODERATE, no link to a page that 404s", () => {
  const lookup = { "new-item": { id: "new-item", title: "Replacement rule", priority: "HIGH" } };
  const rows = buildSupersessionRows([{ old: "self", new: "new-item" }, { old: "gone-item", new: "self" }], "self", lookup);
  assert.deepEqual(rows.map((r) => [r.id, r.title, r.priority, r.label]), [["new-item", "Replacement rule", "HIGH", "Superseded by"]], "the item the reader cannot open is not a row");
  assert.deepEqual(buildSupersessionRows([{ old: "self", new: "unknown" }], "self", {}), []);
  assert.deepEqual(buildSupersessionRows([{ old: "self", new: "unknown" }], "self", null), []);
});
