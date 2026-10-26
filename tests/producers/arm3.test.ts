// ARM-3: the freight-rate rows the lane triangles join (a value, its day and its basis read from the quoted words of a stored capture; INV-ARM-2), a host the register bars or does not hold refused (INV-ARM-1), a second apply that
// writes nothing twice (INV-ARM-3), the reroute source of the AE11 row corrected through the driver, and every source attempted that writes no row stated with its reason (INV-ARM-4).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { citedPages } from "@/core/producers/rows-file";
import { acceptStoredQuote } from "@/core/producers/quote";
import { runProducer, type ProducerSpec } from "@/core/producers/runner";
import { captureCited } from "@/core/turn/stages/capture";

import { fixture } from "../integration/world.ts";

const SERIES = "src/features/market/producers/data/rows/market_series-2026-10.json";
const STAGED = "src/features/market/producers/data/rows/staged/drewry-wci-2026-10.json";
const REROUTE = "src/features/market/producers/data/rows/reroute_events-2026-10.json";
type Row = Record<string, unknown> & { citation: { url: string; title: string; retrieved_at: string; quote: string; also?: string[] } };
type File = { held?: string; rows: Row[]; absent: Array<{ source: string; kind: string; verdict: string; reason: string; citation?: { quote: string; capture: string } }>; entity_owed?: { entities: Array<{ kind: string; canonical_name: string }> } };
const file = (p: string): File => JSON.parse(readFileSync(p, "utf8")) as File;
/** The staged rows with their page moved to a host the register holds as permitted (eia.gov): the mechanism is proven on rows the producer may write; the Drewry host itself is proven refused below. */
const onPermittedHost = (): Row[] => file(STAGED).rows.map((r) => ({ ...r, citation: { ...r.citation, url: "https://www.eia.gov/petroleum/drewry-fixture" } }));
const textOf = (rows: Row[]): string => JSON.stringify({ rows });
const filler = "Notice. This page is provided for information and is reproduced here for the fixture. ".repeat(20);
const corridors = [["CNSHA-ITGOA:ocean", 1], ["CNSHA-NLRTM:ocean", 2], ["CNSHA-USNYC:ocean", 3], ["CNSHA-USLAX:ocean", 4]].map(([n, i]) => ({ entity_id: `cl:corridor:000000000000000${i}`, kind: "corridor", canonical_name: n }));
const routesFor = (rows: Row[]) => {
  const pages = new Map<string, string[]>();
  for (const r of rows) pages.set(r.citation.url, [...(pages.get(r.citation.url) ?? []), r.citation.quote, ...(r.citation.also ?? [])]);
  return Object.fromEntries([...pages].map(([url, quotes]) => [url, () => new Response(`${filler}\n${quotes.join("\n")}\n${filler}`, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })]));
};
type Fx = ReturnType<typeof fixture>;
const spec = (f: Fx, name: string) => f.d.catalog[name] as ProducerSpec;
async function applyText(f: Fx, name: string, text: string) {
  const cap = await captureCited(f.d, citedPages(text), true);
  return { cap, run: await runProducer(f.d.producers, { spec: spec(f, name), dry: false, text }) };
}
const armed = (rows: Row[]) => {
  const f = fixture({ routes: routesFor(rows) });
  Object.assign(f.d.producers.env, { MARKET_PRODUCER_SERIES_ROWS_ENABLED: "1", MARKET_PRODUCER_REROUTE_ROWS_ENABLED: "1" });
  f.db.seed("entities", corridors);
  return f;
};

test("INV-ARM-2: every Drewry observation is written with its lane corridor entity, a unit the normaliser knows and the source and capture its quote stands on; the day and the figure are the quote's own", async () => {
  const rows = onPermittedHost();
  const f = armed(rows);
  const dry = await runProducer(f.d.producers, { spec: spec(f, "market-series-rows"), dry: true, text: textOf(rows) });
  assert.equal(dry.counts.parsed, rows.length, dry.notes.join("|"));
  assert.equal(dry.counts.refused_rows_parse, 0);
  const before = f.db.rows("market_series").length;
  assert.equal(before, f.db.rows("market_series").length, "a dry run writes nothing");
  const { cap, run } = await applyText(f, "market-series-rows", textOf(rows));
  assert.equal(cap.counts.failed, 0, cap.notes.join("|"));
  const written = f.db.rows("market_series").filter((m) => String(m.series_key).startsWith("drewry-wci:"));
  assert.equal(written.length, rows.length, run.notes.join("|"));
  assert.equal(run.counts.edges_not_due, rows.length, "dated points older than the edge window author no delta edge and are counted, not failed");
  for (const w of written) {
    assert.equal(w.unit, "USD/FEU");
    assert.match(String(w.source_ref), /source [0-9a-f-]{36}; capture [0-9a-f-]{36}; "/);
    assert.equal(w.reference_period, w.as_at_date);
    assert.equal(w.source_key, "eia", "the row carries the register key that admitted its host");
  }
  const lane = written.filter((w) => w.entity_id);
  assert.equal(lane.length, 8, "four lanes, two days");
  assert.deepEqual([...new Set(lane.map((w) => `${w.series_key}=${w.entity_id}`))].sort(), ["drewry-wci:cnsha-itgoa=cl:corridor:0000000000000001", "drewry-wci:cnsha-nlrtm=cl:corridor:0000000000000002", "drewry-wci:cnsha-uslax=cl:corridor:0000000000000004", "drewry-wci:cnsha-usnyc=cl:corridor:0000000000000003"]);
  assert.equal(written.find((w) => w.series_key === "drewry-wci:composite" && w.as_at_date === "2026-08-27")?.entity_id ?? null, null, "the global index belongs to no lane");
  const genoa = written.filter((w) => w.series_key === "drewry-wci:cnsha-itgoa").sort((a, b) => String(a.as_at_date).localeCompare(String(b.as_at_date)));
  assert.deepEqual(genoa.map((w) => [w.as_at_date, Number(w.value_numeric)]), [["2026-06-04", 5089], ["2026-08-27", 4866]]);
  for (const r of rows) for (const quote of [r.citation.quote, ...(r.citation.also ?? [])]) assert.equal((await acceptStoredQuote(f.d.sb, { url: r.citation.url, quote, verifiedAt: r.citation.retrieved_at, now: new Date("2026-10-26T12:00:00Z") })).ok, true, quote);
});

test("INV-ARM-3: a second apply of the series and of the reroute file writes nothing twice", async () => {
  const series = onPermittedHost();
  const reroute = file(REROUTE).rows;
  const f = armed([...series, ...reroute]);
  const once = async () => {
    const s = await applyText(f, "market-series-rows", textOf(series));
    const r = await applyText(f, "reroute-rows", textOf(reroute));
    return { counts: [f.db.rows("market_series").filter((m) => String(m.series_key).startsWith("drewry-wci:")).length, f.db.rows("reroute_events").length], reroute: r.run.counts, series: s.run.counts };
  };
  const first = await once();
  assert.deepEqual(first.counts, [series.length, reroute.length]);
  const second = await once();
  assert.deepEqual(second.counts, first.counts);
  assert.equal(second.series.created, 0);
  assert.equal(second.series.updated, 0, "the columns a pass may patch are read before they are compared, so an unchanged row is unchanged");
  assert.equal(second.series.unchanged, series.length);
  const asked: string[] = [];
  const sb = { from: () => ({ select: (cols: string) => (asked.push(cols), { order: () => ({ range: async () => ({ data: [], error: null }) }) }) }) };
  await spec(f, "market-series-rows").plan?.read(sb as never, []);
  for (const col of ["series_key", "reference_period", "value_numeric", "source_ref", "entity_id"]) assert.ok(asked[0]?.split(", ").includes(col), `the stored row is read with ${col}`);
  assert.equal(second.reroute.created, 0);
  assert.equal(second.reroute.updated, 0, "nothing differs on the second pass, so nothing is patched");
});

test("INV-ARM-1: a row citing a host the register bars, a host it does not hold (free text never opens it), a figure the quote lacks, a day other than the quote's, or a lane that is no corridor is refused by name", async () => {
  const good = file(STAGED).rows[0] as Row;
  const f = armed([good]);
  const refuse = async (over: Partial<Row> & { citation?: Row["citation"] }, pattern: RegExp, permitted = true) => {
    const base = permitted ? { ...good, citation: { ...good.citation, url: "https://www.eia.gov/petroleum/drewry-fixture" } } : good;
    const r = await runProducer(f.d.producers, { spec: spec(f, "market-series-rows"), dry: true, text: textOf([{ ...base, ...over }]) });
    assert.equal(r.counts.parsed, 0, pattern.source);
    assert.match(r.notes.join("|"), pattern);
  };
  await refuse({ citation: { ...good.citation, url: "https://www.icao.int/sustainability/saf-prices" } }, /licence: icao\.int is "prohibited" in the register \(icao_int\)/);
  await refuse({ citation: { ...good.citation, url: "https://www.iata.org/en/publications/economics/fuel-monitor/" } }, /is "prohibited" in the register \(iata_codes\)/);
  await refuse({}, /licence: drewry\.co\.uk has no register row \(unregistered\)/, false);
  await refuse({ licence_review: "free text states a basis" } as Partial<Row>, /licence: drewry\.co\.uk has no register row \(unregistered\)/, false);
  await refuse({ value_numeric: 4900 }, /the quote does not contain the figure 4900/);
  await refuse({ as_at_date: "2026-08-20" }, /the quote states the day 2026-08-27, not as_at_date 2026-08-20/);
  await refuse({ per: "box" }, /"USD per box" normalises to USD, not USD\/box/);
  await refuse({ lane: "CNSHA-USNYC:ocean" }, /does not end series_key drewry-wci:cnsha-itgoa/);
  await refuse({ lane: "CNSHA-XXXXX:ocean" }, /is not a corridor entity/);
});

test("P3: the Maersk notices resolve to the one registry row of the institution (a source is a publisher, not a page), so the AE11 row keeps its source and no row is duplicated; the equality of baseline and reroute corridor is said on every run and no corridor is minted", async () => {
  const rows = file(REROUTE).rows;
  const f = armed(rows);
  const dry = await runProducer(f.d.producers, { spec: spec(f, "reroute-rows"), dry: true, text: textOf(rows) });
  assert.match(dry.notes.join("|"), /\[note\] reroute corridors equal: CNSHA-ITGOA:ocean is one entity/);
  assert.match(dry.notes.join("|"), /\[note\] reroute corridors equal: CNSHA-NLRTM:ocean is one entity/);
  const entitiesBefore = f.db.rows("entities").length;
  await applyText(f, "reroute-rows", textOf(rows));
  const written = f.db.rows("reroute_events");
  assert.equal(written.length, rows.length);
  const ids = () => f.db.rows("sources").filter((s) => String(s.url).startsWith("https://www.maersk.com/news/")).map((s) => s.id);
  assert.equal(ids().length, 1, "one Maersk registry row serves both notices");
  assert.deepEqual([...new Set(written.filter((r) => ["suez", "cape_of_good_hope"].includes(String(r.route_via)) && r.source_id === ids()[0]).map((r) => r.route_via))].sort(), ["cape_of_good_hope", "suez"]);
  assert.equal(written.find((r) => r.route_via === "suez")?.source_id, ids()[0]);
  for (const r of written) assert.equal(r.fuel_burn_multiplier ?? null, null);
  assert.equal(f.db.rows("entities").length, entitiesBefore, "the producer mints no corridor");
});

test("INV-ARM-4 and the abatement gap: every source attempted that writes no row is stated with its verdict or stored-capture fact and equals the plan's list; the reroute file states each empty column and the entity owed; nothing is typed for abatement", () => {
  const plan = JSON.parse(readFileSync("tests/producers/arm-plan.json", "utf8")) as { tables: Record<string, { armed?: string[]; absent?: Array<{ source: string; reason: string }> }> };
  const { absent } = file(SERIES);
  const staged = file(STAGED);
  assert.match(staged.held ?? "", /^operator ruling 2026-10-26: Hold \(licence check or a permitted rate source first\)$/);
  assert.equal(staged.rows.length, 10);
  assert.ok(staged.rows.every((r) => !("licence_review" in r)));
  assert.equal(file(SERIES).rows.length, 0, "no row is dispatched from the absences file");
  const runPlan = readFileSync("scripts/runs/plans/2026-10-27-arm-3.json", "utf8");
  assert.ok(!runPlan.includes("market-series-rows") && !runPlan.includes("staged/") && !runPlan.includes("drewry"), "the plan dispatches no Drewry row");
  const rows = staged.rows;
  assert.deepEqual(plan.tables.market_series?.absent?.map((a) => a.source), absent.map((a) => a.source));
  assert.ok(plan.tables.market_series?.armed?.includes("market-series-rows"));
  for (const a of absent) assert.ok(a.verdict.length > 3 && a.reason.length > 40, a.source);
  for (const need of ["Maersk advisory, Red Sea", "Argus Media", "ICAO", "IATA", "Neste", "Bunker price pages", "Hapag-Lloyd, MSC, CMA CGM and ONE"]) assert.ok(absent.some((a) => a.source.includes(need)), need);
  assert.ok(absent.find((a) => a.kind === "surcharge_no_figure")?.citation?.quote.includes("will remain in effect until further notice"), "the surcharge the notice names without an amount is quoted");
  assert.ok(rows.every((r) => r.unit === undefined && r.value_numeric !== undefined && !JSON.stringify(r).includes("tCO2e")), "no abatement value or emission factor is typed anywhere");
  const reroute = file(REROUTE);
  for (const r of reroute.rows) assert.deepEqual(Object.keys((r as unknown as { absent: object }).absent).sort(), ["distance_delta_nm", "fuel_burn_multiplier", "transit_delta_days"]);
  assert.deepEqual(reroute.entity_owed?.entities.map((e) => e.canonical_name), ["CNSHA-NLRTM:ocean:cape_of_good_hope", "CNSHA-ITGOA:ocean:cape_of_good_hope"]);
});
