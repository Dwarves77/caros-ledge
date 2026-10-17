import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSeriesBoard, type SeriesRow } from "@/features/market/lib/series-board";
import { envelopeFromFactorRow, envelopeFromPriceStat, envelopeFromSeriesRow, provenanceRows, ratingText } from "@/features/market/lib/provenance";
import { perSeriesWindow, readDeltaEdges, readMarket, readMarketDetail, readMarketSeries, readPanels, readSourceRatings, section } from "@/features/market/read";

import { MemDb, type Row } from "../_support/memdb.ts";

const ITEM = "70869a22-39eb-4eb7-ba49-d3826b5b2265";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ECB_URL = "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html";
const point = (key: string, period: string, value: number, over: Row = {}): Row => ({ id: `${key}@${period}`, series_key: key, label: key, reference_period: period, as_at_date: period, value_numeric: value, unit: "USD/EUR", currency: "USD", derivation: "observed", origin_class: "official", source_key: "ecb", source_ref: "ECB reference rates", ...over });

type Rpc = (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } };
/** The fixture database with the paged rpc reads the list readers use (`rpc(...).range(a, b)`), over the same rows. */
function withRpc(db: MemDb, scripts: Record<string, Rpc>) {
  const calls: string[] = [];
  const client = {
    from: (t: string) => db.from(t),
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      calls.push(name);
      const run = (range: [number, number] | null) => Promise.resolve({ data: null, error: null, ...(scripts[name]?.(args) ?? { error: { message: `rpc ${name} is not scripted` } }), ...(range ? {} : {}) });
      return { range: (a: number, b: number) => run([a, b]), then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run(null).then(res, rej) };
    },
  };
  return { client: client as never, calls };
}

function world(): MemDb {
  const db = new MemDb({}, {});
  db.seed("data_sources", [
    { source_key: "ecb", name: "European Central Bank", redistribution: "permitted", embeddable: true, url: ECB_URL, licence: "ECB legal notice", attribution: "European Central Bank" },
    { source_key: "eia", name: "US EIA", redistribution: "permitted", embeddable: true, url: "https://www.eia.gov/opendata/", licence: "US public domain", attribution: "US EIA" },
    { source_key: "sbti_dashboard", name: "SBTi", redistribution: "prohibited", embeddable: false, url: "https://sciencebasedtargets.org/target-dashboard", licence: null, attribution: null },
  ]);
  db.views.licence_clear_sources = () => db.rows("data_sources").filter((s) => s.embeddable === true).map((s) => ({ source_key: s.source_key, name: s.name, attribution: s.attribution, licence: s.licence, url: s.url, verified_on: null }));
  db.seed("sources", [{ id: "s-ecb", name: "ECB", url: "https://www.ecb.europa.eu/", base_tier: 3, effective_tier: null, tier_override: null, status: "active" }]);
  db.seed("market_series", [point("ecb-fx:eur-usd", "2026-10-08", 1.05), point("ecb-fx:eur-usd", "2026-10-15", 1.1), point("eia-v2:wti", "2026-10-12", 70, { source_key: "eia", unit: "USD/bbl" })]);
  return db;
}

test("INV-262 readSourceRatings: the registry row's tier wins, else the institution class table; licence only where redistribution is permitted", async () => {
  const db = world();
  const r = await readSourceRatings(db.client, ["ecb", "eia", "sbti_dashboard", "ecb", null, "nope"]);
  assert.deepEqual(Object.keys(r).sort(), ["ecb", "eia", "sbti_dashboard"], "an unknown key has no rating entry, a duplicate one entry");
  assert.deepEqual([r.ecb?.tier, r.ecb?.via, r.ecb?.licence], [3, "registry", "ECB legal notice"], "the registered source of the host rates it, not the class table");
  assert.deepEqual([r.eia?.tier, r.eia?.via], [2, "class"], "no registry row: the class table's tier for a government host");
  assert.deepEqual([r.sbti_dashboard?.licence, r.sbti_dashboard?.attribution], [null, null], "a source that does not permit redistribution shows no licence text");
  db.rows("sources")[0]!.tier_override = 1;
  assert.equal((await readSourceRatings(db.client, ["ecb"])).ecb?.tier, 1, "override first, then effective, then base (customerTierOf)");
  db.fail("data_sources", "select", "down");
  await assert.rejects(readSourceRatings(db.client, ["ecb"]), /down|failed/);
});

test("INV-262 the envelope of every market figure carries its source's rating, and the drawer always has the rating row", async () => {
  const db = world();
  const ratings = await readSourceRatings(db.client, ["ecb"]);
  const board = buildSeriesBoard(db.rows("market_series") as SeriesRow[]);
  const row = board.groups.find((g) => g.keyPrefix === "ecb-fx")?.series[0];
  assert.ok(row);
  const env = envelopeFromSeriesRow(row, { sourceUrl: null, sourceName: "x" }, ratings.ecb ?? null);
  assert.equal(env.sourceTier, 3);
  const rows = provenanceRows(env);
  assert.deepEqual(rows.find((r) => r.label === "Source rating")?.value, "T3 · " + ratingText(3).split(" · ")[1]);
  assert.equal(rows.find((r) => r.label === "Source ref")?.href, ECB_URL, "the source ref links to the source");
  const unrated = provenanceRows(envelopeFromSeriesRow(row, null, null));
  assert.equal(unrated.find((r) => r.label === "Source rating")?.value, "Unrated", "a figure whose source could not be placed says Unrated, the row stays");
  assert.equal(envelopeFromPriceStat({ sourceTier: 4, releasedAt: "2026-10-01" }, ratings.ecb ?? null).sourceTier, 4, "a stored rating is the fact");
  assert.equal(envelopeFromPriceStat({ sourceTier: null }, ratings.ecb ?? null).sourceTier, 3, "no stored rating: the series' source's");
  assert.equal(envelopeFromFactorRow({ source_key: "ecb", derivation: "observed" }, ratings.ecb ?? null).sourceTier, 3);
  assert.ok(!provenanceRows({ ...env, sourceTier: null }).some((r) => /pending|unscored/i.test(r.value)));
});

test("perSeriesWindow: each series keeps the year behind ITS OWN latest period, and a quiet series keeps its latest row", () => {
  const rows = [point("a:x", "2024-01-01", 1), point("a:x", "2025-09-01", 2), point("a:x", "2026-10-01", 3), point("b:y", "2024-02-01", 9)] as SeriesRow[];
  const kept = perSeriesWindow(rows).map((r) => `${r.series_key}@${r.reference_period}`);
  assert.deepEqual(kept, ["a:x@2025-09-01", "a:x@2026-10-01", "b:y@2024-02-01"]);
});

test("readMarketSeries: the board, the SBTi rows, the ratings, and the lineage only when a service client is given", async () => {
  const db = world();
  const without = await readMarketSeries(db.client);
  assert.equal(without.lineage, null, "no service client: the lineage is unknown, not empty");
  assert.equal(without.board.totalObservedSeries, 2);
  assert.equal(without.ratings.ecb?.tier, 3);
  db.seed("derivation_edges", [{ from_table: "market_series", from_pk: "ecb-fx:eur-usd@2026-10-15", to_value_id: "d0000000-0000-4000-8000-000000000001", edge_kind: "input", to_table: "derived_values" }]);
  const withEdges = await readMarketSeries(db.client, { edgeDb: db.client });
  assert.deepEqual([...(withEdges.lineage ?? [])], ["ecb-fx:eur-usd@2026-10-15"]);
  assert.deepEqual([...(await readDeltaEdges(db.client, ["eia-v2:wti@2026-10-12", "ecb-fx:eur-usd@2026-10-15"]))], ["ecb-fx:eur-usd@2026-10-15"], "the eia point has no edge; the check is per row, from market_series only");
});

test("INV-263 readMarket: every part is independent, and a failed read is its own failure, never an empty list or a zero", async () => {
  const db = world();
  const c = withRpc(db, { get_market_intel_items_public: () => ({ error: { message: "rpc down" } }), get_surface_counts: () => ({ data: { total_items: 0 } }) });
  const r = await readMarket(c.client, { orgId: ORG_A });
  assert.equal(r.signals.ok, false, "the signal list failed and says so");
  assert.equal(r.series.ok, true, "the series part stands");
  assert.equal(r.panels.oem.ok && r.panels.oem.data.length, 0, "an honest empty is ok with no rows");
  db.fail("market_series", "select", "down");
  const r2 = await readMarket(c.client, { orgId: ORG_A });
  assert.equal(r2.series.ok, false);
  assert.match(r2.series.ok ? "" : r2.series.error, /down|failed/);
  db.fail("oem_tech_roadmaps", "select", "oem down");
  assert.equal((await readMarket(c.client, { orgId: ORG_A })).panels.oem.ok, false);
});

test("readMarket: the list is the public market RPC with its counts, and a good read has rows", async () => {
  const db = world();
  const c = withRpc(db, {
    get_market_intel_items_public: () => ({ data: [{ id: ITEM, legacy_id: null, title: "Diesel", item_type: "market_signal", effective_priority: "HIGH", added_date: "2026-10-01", severity: "cost_alert", source_id: null }] }),
    get_surface_counts: () => ({ data: { total_items: 1, by_priority: { HIGH: 1 }, by_jurisdiction: {} } }),
  });
  const r = await readMarket(c.client, { orgId: null });
  assert.ok(r.signals.ok);
  if (r.signals.ok) assert.deepEqual([r.signals.data.rows.map((x) => x.title), r.signals.data.aggregates?.totalItems], [["Diesel"], 1]);
  assert.deepEqual([...c.calls].sort(), ["get_market_intel_items_public", "get_surface_counts"]);
});

test("the indexation panel shows only the viewer's organisation, and none for a viewer with no organisation", async () => {
  const db = world();
  const clause = (id: string, org: string, ref: string): Row => ({ clause_id: id, contract_ref: ref, corridor_id: null, index_id: "brent", base_value: 100, base_date: "2026-01-01", passthrough_pct: 50, cap_pct: null, floor_pct: null, review_cadence: "quarterly", rounding_rule: "nearest", org_id: org });
  db.seed("indexation_clauses", [clause("c1", ORG_A, "A-1"), clause("c2", ORG_B, "B-1")]);
  const a = await readPanels(db.client, ORG_A);
  assert.deepEqual(a.indexation.ok && a.indexation.data.map((c) => c.contract_ref), ["A-1"]);
  const none = await readPanels(db.client, null);
  assert.deepEqual(none.indexation.ok && none.indexation.data, []);
  assert.ok(db.reads("indexation_clauses").every((c) => c.filters.some(([kind, col]) => kind === "eq" && col === "org_id")), "every indexation read is scoped to an org");
});

test("readMarketDetail: the price board with its stored or inherited rating, the ratified series figure, the convergence, each part its own section", async () => {
  const db = world();
  db.seed("intelligence_items", [{ id: ITEM, title: "Diesel", domain: 4 }]);
  db.seed("market_series_items", [{ series_key: "ecb-fx:eur-usd", item_id: ITEM, status: "ratified" }, { series_key: "ecb-fx:eur-gbp", item_id: ITEM, status: "pending" }]);
  db.seed("published_price_statistics", [{ id: "p1", item_id: ITEM, label: "EUR/USD", value_display: "$1.10", unit: "/EUR", context_line: null, severity_tone: null, source_tier: null, released_at: "2026-10-15", next_release_at: "2026-10-16", next_release_label: null, sort_order: 0 }]);
  db.seed("sources", [{ id: "s-citing", name: "Citing", url: "https://x.example.org/", base_tier: 4, independent_citers: 3, confirmation_count: 5 }]);
  const c = withRpc(db, { get_market_intel_items_public: () => ({ data: [] }) });
  const d = await readMarketDetail(c.client, { id: ITEM, sourceId: "s-citing" });
  assert.deepEqual(d.convergence.ok && d.convergence.data, { independent_citers: 3, confirmation_count: 5 });
  assert.ok(d.priceBoard.ok && d.priceBoard.data[0]?.valueDisplay === "$1.10");
  assert.ok(d.seriesFigure.ok && d.seriesFigure.data);
  if (d.seriesFigure.ok && d.seriesFigure.data) {
    assert.deepEqual([d.seriesFigure.data.row.seriesKey, d.seriesFigure.data.rating?.tier, d.seriesFigure.data.cadenceDays], ["ecb-fx:eur-usd", 3, 1], "the ratified series only, with its source's rating and its producer's cadence");
    assert.equal(d.seriesFigure.data.row.deltas.delta1w?.value !== undefined, true);
  }
  db.fail("published_price_statistics", "select", "stats down");
  const d2 = await readMarketDetail(c.client, { id: ITEM, sourceId: "s-citing" });
  assert.equal(d2.priceBoard.ok, false, "a failed price board is its own failure");
  assert.equal(d2.seriesFigure.ok, true, "and the rest of the page stands");
  const unknown = await readMarketDetail(c.client, { id: "no-such-legacy-id" });
  assert.equal(unknown.priceBoard.ok, false, "an item that cannot be identified has no price board, said so");
});

test("section(): a thrown read is a named failure, a value is ok", async () => {
  assert.deepEqual(await section("x", async () => 1), { ok: true, data: 1 });
  const bad = await section("x", async () => {
    throw new Error("nope");
  });
  assert.deepEqual(bad, { ok: false, error: "nope" });
});
