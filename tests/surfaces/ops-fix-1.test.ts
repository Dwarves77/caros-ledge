// OPS-FIX-1 items 1 and 2: the grid queue and the recalculated figures are the profile's own, on real reads over the in-memory database.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";

import { entityId } from "@/core/entities";
import { profileScope, readDerivedFigures, readSpec09, type OperationsRegion } from "@/features/operations/read/operations-reads";
import { GridQueuePanel } from "@/features/operations/ui/Spec09Panels";

import { memoryDb, type Row } from "../_support/memory-db.ts";
import { renderApp, textOf } from "../_support/render.ts";

const R_EU = "e0000000-0000-4000-8000-000000000001";
const R_US = "e0000000-0000-4000-8000-000000000002";
const ROSTER: OperationsRegion[] = [{ id: R_EU, code: "EU", label: "European Union", displayOrder: 1, isoCodes: ["DE", "FR"] }, { id: R_US, code: "US", label: "United States", displayOrder: 2, isoCodes: ["US"] }];
const draw = (el: ReturnType<typeof createElement>) => textOf(renderApp(el));

const GB = entityId("jurisdiction", "GB");
const queueRow = (id: string, o: Row = {}): Row => ({ queue_id: id, jurisdiction_id: GB, dso_name: "UK Power Networks", capacity_band_mw: null, queue_months_p50: null, queue_months_p90: null, as_of: "2026-09-01", substation_name: `Substation ${id}`, demand_firm_mw: 10, demand_available_mw: 4, demand_constraint: "AMBER", demand_constraint_limiting_factor: null, ...o });
const panel = (g: Awaited<ReturnType<typeof readSpec09>>, jurisdiction: string) => draw(createElement(GridQueuePanel, { rows: g.grid, headroomOnly: g.gridHeadroomOnly, jurisdiction, retryHref: "/operations/x" }));

test("OPS-FIX-1 item 1: the grid queue is the profile's own jurisdiction; the US profile holds none and says so; the UK draws only rows with a queue time and counts the headroom-only substations", async () => {
  const db = memoryDb({ grid_connection_queues: [queueRow("a1"), queueRow("a2"), queueRow("a3", { queue_months_p90: 30, capacity_band_mw: "10-50" })], regional_data_facts: [] }).db;
  const us = await readSpec09(db, null, profileScope({ jurisdictionIso: ["US"] }, ROSTER));
  assert.deepEqual([us.grid, us.gridHeadroomOnly], [[], 0], "no UK row on a US profile");
  assert.match(panel(us, "United States"), /No grid-connection queue data is held for United States yet\. The UK is the only network with published queue figures in the ledger\./);
  const gb = await readSpec09(db, null, profileScope({ jurisdictionIso: ["UK"] }, ROSTER));
  assert.deepEqual([gb.grid?.map((r) => r.queue_id), gb.gridHeadroomOnly], [["a3"], 2], "UK aliases to GB; a row with neither p50 nor p90 is not a queue entry");
  const text = panel(gb, "United Kingdom");
  assert.match(text, /2 substations in United Kingdom have headroom figures but no queue time is published/);
  assert.doesNotMatch(text, /p50 not recorded · p90 not recorded/);
});

test("OPS-FIX-1 item 1: a jurisdiction whose rows all lack a queue time says how many substations carry headroom only, not 25 UNKNOWN rows", async () => {
  const db = memoryDb({ grid_connection_queues: [queueRow("a1"), queueRow("a2")] }).db;
  const gb = await readSpec09(db, null, profileScope({ jurisdictionIso: ["GB"] }, ROSTER));
  assert.deepEqual([gb.grid, gb.gridHeadroomOnly], [[], 2]);
  const text = panel(gb, "United Kingdom");
  assert.match(text, /2 substations in United Kingdom have headroom figures but no queue time is published/);
  assert.doesNotMatch(text, /UNKNOWN/);
  const down = await readSpec09(memoryDb({}, { failures: [{ table: "grid_connection_queues", op: "select", message: "boom" }] }).db, null, profileScope({ jurisdictionIso: ["GB"] }, ROSTER));
  assert.deepEqual([down.grid, down.gridHeadroomOnly], [null, null], "a failed read is a failed state, not an empty queue");
});

const NOW = "2026-10-25T12:00:00.000Z";
const B1 = "5a000000-0000-4000-8000-0000000000b1";
const B2 = "5a000000-0000-4000-8000-0000000000b2";
const EU_ENT = entityId("jurisdiction", "EU");
const series = (id: string, period: string, entity: string | null): Row => ({ id, label: "Heavy fuel oil 3.5%S (EU average)", reference_period: period, source_key: "ecb", entity_id: entity });
const delta = (id: string, value: string, o: Row = {}): Row => ({ value_id: id, entity_id: null, method_id: "market_series_delta", method_version: "1.0.0", value, unit: "EUR/tonne", currency: null, derivation: "calculated", origin_class: "derived", lifecycle: "verified", admissibility: "calculation_ok", base_confidence: "0.9", asserted_at: NOW, computed_at: NOW, supersedes: null, inputs: [{ table: "market_series", pk: B1 }, { table: "market_series", pk: B2 }], ...o });
const OLD = "d2000000-0000-4000-8000-0000000000f1";
const world = (rows: Row[], market: Row[] = [series(B1, "2026-10-19", EU_ENT), series(B2, "2026-08-31", null)]) => memoryDb({
  derived_values: [delta(OLD, "132.88", { admissibility: "stale", inputs: [] }), ...rows],
  market_series: market,
  data_sources: [{ source_key: "ecb", name: "ECB", url: "https://www.ecb.europa.eu/", redistribution: "free", embeddable: true, licence: "x", attribution: "x" }],
}).db;
const eu = profileScope({ jurisdictionIso: ["DE"] }, ROSTER);
const us = profileScope({ jurisdictionIso: ["US"] }, ROSTER);

test("OPS-FIX-1 item 2a: a figure resting on the EU series is on EU profiles and not on a US profile", async () => {
  const db = world([delta("d2000000-0000-4000-8000-000000000002", "140.5", { supersedes: OLD })]);
  assert.deepEqual((await readDerivedFigures(db, eu)).map((f) => [f.value, f.previous]), [[140.5, 132.88]], "DE falls in the EU region");
  assert.deepEqual(await readDerivedFigures(db, us), [], "the EU series is not a US figure");
  assert.equal((await readDerivedFigures(db, null)).length, 1, "the list spans all regions");
});

test("OPS-FIX-1 item 2c: a recalculation equal to the value it replaced is not a notice", async () => {
  const db = world([delta("d2000000-0000-4000-8000-000000000002", "132.88", { supersedes: OLD })]);
  assert.deepEqual(await readDerivedFigures(db, eu), []);
});

test("OPS-FIX-1 item 2: a global figure (inputs that name no place) shows on every profile, and a pattern row is not on this rail", async () => {
  const db = world(
    [delta("d2000000-0000-4000-8000-000000000003", "0.07", { unit: "USD/EUR" }), delta("d2000000-0000-4000-8000-000000000004", "3", { method_id: "pattern_velocity_burst" })],
    [series(B1, "2026-10-15", null), series(B2, "2026-10-08", null)],
  );
  assert.deepEqual((await readDerivedFigures(db, us)).map((f) => f.valueId), ["d2000000-0000-4000-8000-000000000003"]);
});

test("OPS-FIX-1 item 2b: a movement is named for the span its two observations cover: a week for 5 to 9 days, the real span otherwise, never one-week for seven weeks", async () => {
  const row = delta("d2000000-0000-4000-8000-000000000002", "140.5", { supersedes: OLD });
  assert.equal((await readDerivedFigures(world([row]), eu))[0]?.title, "7-week movement · Heavy fuel oil 3.5%S (EU average)", "2026-10-19 against 2026-08-31 is 49 days");
  const week = world([row], [series(B1, "2026-10-19", null), series(B2, "2026-10-12", null)]);
  assert.equal((await readDerivedFigures(week, us))[0]?.title, "One-week movement · Heavy fuel oil 3.5%S (EU average)");
  const days = world([row], [series(B1, "2026-10-19", null), series(B2, "2026-10-07", null)]);
  assert.equal((await readDerivedFigures(days, us))[0]?.title, "12-day movement · Heavy fuel oil 3.5%S (EU average)");
  const undated = world([row], [series(B1, "latest", null), series(B2, "prior", null)]);
  assert.equal((await readDerivedFigures(undated, us))[0]?.title, "Movement · Heavy fuel oil 3.5%S (EU average)", "unknown dates name no span");
});
