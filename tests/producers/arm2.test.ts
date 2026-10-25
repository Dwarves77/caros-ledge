// ARM-2: the instruments' own schedules as statutory_computations rows (INV-ARM-5: no row without a verbatim quote that contains its figure), reroute events that name their route and carry a source but never a typed multiplier
// (INV-ARM-6), a second apply that writes nothing twice in all four tables (INV-ARM-7), the capture path that reaches an EUR-Lex instrument through Cellar and a walled page through the browser tier, and the licence rows of ecb-fx and
// the UKPN heatmap.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { licenceGate } from "@/core/contracts";
import { entityId } from "@/core/entities";
import { citedPages } from "@/core/producers/rows-file";
import { runProducer, type ProducerSpec } from "@/core/producers/runner";
import { captureCited } from "@/core/turn/stages/capture";
import { auxiliaryEnergyRows, indexationRows } from "@/features/operations/producers/operator-rows";

import { ARM2_DOWN_FILE, ARM2_KEYS, ARM2_MIGRATION_FILE, renderArm2Down, renderArm2Migration } from "../golden/_migration.ts";
import { fixture } from "../integration/world.ts";

const STAT = "src/features/statutory/producers/data/rows/statutory_computations-2026-10.json";
const REROUTE = "src/features/market/producers/data/rows/reroute_events-2026-10.json";
type Row = Record<string, unknown> & { citation: { url: string; title: string; retrieved_at: string; quote: string; also?: string[] } };
const rowsOf = (path: string): Row[] => (JSON.parse(readFileSync(path, "utf8")) as { rows: Row[] }).rows;
const textOf = (rows: Row[]): string => JSON.stringify({ rows });
/** A quote as a person reads its numbers: a comma is a decimal point and a space groups thousands (the Official Journal's way). */
const readable = (q: string): string => q.replace(/(\d) (\d{3})/g, "$1$2").replace(/(\d),(\d)/g, "$1.$2");
const filler = "Notice. This page is provided for information and is reproduced here for the fixture. ".repeat(20);

/** The routes a fixture needs for a rows file: every cited page answers with the quotes it is cited for; an EUR-Lex CELEX page is served by Cellar, the way the capture path reaches it. */
function routesFor(rows: Row[]): Record<string, () => Response> {
  const pages = new Map<string, string[]>();
  for (const r of rows) pages.set(r.citation.url, [...(pages.get(r.citation.url) ?? []), r.citation.quote, ...(r.citation.also ?? [])]);
  return Object.fromEntries([...pages].map(([url, quotes]) => {
    const celex = /[?&]uri=CELEX:([\w()-]+)/i.exec(url)?.[1];
    const served = celex ? `https://publications.europa.eu/resource/celex/${celex}` : url;
    return [served, () => new Response(`${filler}\n${quotes.join("\n")}\n${filler}`, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })];
  }));
}
const corridors = [{ entity_id: "cl:corridor:0000000000000001", kind: "corridor", canonical_name: "CNSHA-NLRTM:ocean" }, { entity_id: "cl:corridor:0000000000000002", kind: "corridor", canonical_name: "CNSHA-ITGOA:ocean" }];
type Fx = ReturnType<typeof fixture>;
/** The apply path of a dispatch: the cited pages are captured first, then the producer writes (propagate.ts runs these two in this order). */
async function applyText(f: Fx, name: string, text: string) {
  const cap = await captureCited(f.d, citedPages(text), true);
  const run = await runProducer(f.d.producers, { spec: f.d.catalog[name] as ProducerSpec, dry: false, text });
  return { cap, run };
}

test("S1: the statutory schedules parse dry with no refusal, then apply writes one row per instrument, formula and scenario with the registered source and the capture its quote stands on", async () => {
  const rows = rowsOf(STAT);
  assert.ok(rows.length >= 30, "the four instrument families are transcribed");
  const f = fixture({ routes: routesFor(rows) });
  Object.assign(f.d.producers.env, { STATUTORY_PRODUCER_SCHEDULES_ENABLED: "1" });
  const spec = f.d.catalog["statutory-schedules"] as ProducerSpec;
  const dry = await runProducer(f.d.producers, { spec, dry: true, text: textOf(rows) });
  assert.equal(dry.counts.parsed, rows.length, dry.notes.join("|"));
  assert.equal(dry.counts.refused_rows_parse, 0);
  const { cap, run } = await applyText(f, "statutory-schedules", textOf(rows));
  assert.equal(cap.counts.failed, 0, cap.notes.join("|"));
  const written = f.db.rows("statutory_computations");
  assert.equal(written.length, rows.length, run.notes.join("|"));
  assert.equal(new Set(written.map((r) => `${r.entity_id}|${r.formula_id}|${r.formula_version}|${r.scenario_key}`)).size, rows.length, "one row per instrument, formula and scenario");
  for (const r of written) {
    const proof = (r.inputs as Array<Record<string, string>>)[0] as Record<string, string>;
    assert.ok(proof.pk && proof.capture_id, "the registered source and the capture it was verified on");
    assert.equal(proof.admissibility, "filing_ok");
    assert.ok(readable(proof.quote as string).includes(String(Number(r.result))), `${String(r.formula_id)} ${String(r.scenario_key)}: the stored quote contains its figure`);
    assert.equal(r.formula_version, "1.0.0");
  }
  assert.equal(f.db.rows("entity_identifiers").filter((i) => i.scheme === "CELEX").length, 4, "the four instruments, authored by the instrument path");
  assert.ok(written.every((r) => f.db.rows("entities").some((e) => e.entity_id === r.obligation_id && e.kind === "obligation")));
});

test("S1 links a schedule row to the obligation its instrument already holds for the cited article (the current version), mints one only where none exists, and a second apply mints nothing", async () => {
  const rows = rowsOf(STAT);
  const f = fixture({ routes: routesFor(rows) });
  Object.assign(f.d.producers.env, { STATUTORY_PRODUCER_SCHEDULES_ENABLED: "1" });
  const [ets, cbam] = [entityId("instrument", "32003L0087"), entityId("instrument", "32023R0956")];
  const held = (o: Record<string, unknown>) => ({ version: 1, supersedes: null, ...o });
  f.db.seed("obligation_objects", [
    held({ obligation_id: "cl:obligation:00000000000000a1", instrument_entity_id: ets, pinpoint_citation: "Article 3gb" }),
    held({ obligation_id: "cl:obligation:00000000000000b1", instrument_entity_id: cbam, pinpoint_citation: "Article 32" }),
    held({ obligation_id: "cl:obligation:00000000000000b2", instrument_entity_id: cbam, pinpoint_citation: "Article 32", version: 2, supersedes: "cl:obligation:00000000000000b1" }),
    held({ obligation_id: "cl:obligation:00000000000000c1", instrument_entity_id: ets, pinpoint_citation: "Article 12" }),
  ]);
  await applyText(f, "statutory-schedules", textOf(rows));
  const written = f.db.rows("statutory_computations");
  const of = (formula: string) => written.filter((r) => r.formula_id === formula);
  assert.deepEqual([...new Set(of("ets_maritime_phase_in").map((r) => r.obligation_id))], ["cl:obligation:00000000000000a1"], "the three Article 3gb rows link to the instrument's own obligation");
  assert.deepEqual(of("cbam_definitive_period").map((r) => [r.scenario_key, r.obligation_id]).sort(), [["start_year", entityId("obligation", "CBAM definitive period of Regulation (EU) 2023/956")], ["transitional_end_year", "cl:obligation:00000000000000b2"]], "Article 32 links to the current version; Article 36 has none and is minted");
  assert.ok(of("fueleu_intensity_reduction").every((r) => String(r.obligation_id) === entityId("obligation", "FuelEU Maritime Article 4(2) GHG intensity limit on the energy used on board")), "an instrument with no object for the article gets a minted obligation");
  assert.equal(written.filter((r) => (r.inputs as Array<Record<string, unknown>>)[0]?.linked_obligation_id).length, 4, "the linked rows say so in their inputs");
  const minted = f.db.rows("entities").filter((e) => e.kind === "obligation").length;
  assert.equal(minted, 5, "FuelEU Article 4(2), FuelEU Article 23, ReFuelEU Annex I, CBAM factor, CBAM definitive period: the linked rows mint none");
  await applyText(f, "statutory-schedules", textOf(rows));
  assert.equal(f.db.rows("entities").filter((e) => e.kind === "obligation").length, minted, "a second apply mints nothing");
  assert.equal(f.db.rows("statutory_computations").length, rows.length);
});

test("INV-ARM-5: a planted row whose quote paraphrases the figure is refused at parse, a planted row whose quote is not on the capture is refused at apply, and the genuine row beside them is written", async () => {
  const real = rowsOf(STAT);
  const good = real[0] as Row;
  const paraphrase: Row = { ...good, scenario_key: "2024-paraphrase", citation: { ...good.citation, quote: "forty per cent of the verified emissions reported for 2024" } };
  const invented: Row = { ...good, scenario_key: "2024-invented", result: 45, citation: { ...good.citation, quote: "a 45 % share of the verified emissions reported for 2024" } };
  const wrongFigure: Row = { ...good, scenario_key: "2024-wrong", result: 41, citation: good.citation };
  const planted = [paraphrase, invented, wrongFigure, good];
  const f = fixture({ routes: routesFor([good]) });
  Object.assign(f.d.producers.env, { STATUTORY_PRODUCER_SCHEDULES_ENABLED: "1" });
  const { run } = await applyText(f, "statutory-schedules", textOf(planted));
  const notes = run.notes.join("|");
  assert.match(notes, /2024-paraphrase\): the quote does not contain the figure 40/);
  assert.match(notes, /2024-wrong\): the quote does not contain the figure 41/);
  assert.match(notes, /quote_not_in_capture/);
  assert.deepEqual(f.db.rows("statutory_computations").map((r) => r.scenario_key), [good.scenario_key]);
});

test("S2 and INV-ARM-6: reroute rows carry their route and their source, never a multiplier, and a typed multiplier is refused; a Suez and a Cape row of one corridor both land", async () => {
  const rows = rowsOf(REROUTE);
  const f = fixture({ routes: routesFor(rows) });
  Object.assign(f.d.producers.env, { MARKET_PRODUCER_REROUTE_ROWS_ENABLED: "1" });
  f.db.seed("entities", corridors);
  const typed: Row = { ...(rows[0] as Row), route_via: "suez", fuel_burn_multiplier: 1.4 };
  const refusal = await runProducer(f.d.producers, { spec: f.d.catalog["reroute-rows"] as ProducerSpec, dry: true, text: textOf([typed]) });
  assert.match(refusal.notes.join("|"), /a typed fuel_burn_multiplier \(1\.4\) is refused/);
  assert.equal(refusal.counts.parsed, 0);
  const { cap, run } = await applyText(f, "reroute-rows", textOf(rows));
  assert.equal(cap.counts.failed, 0, cap.notes.join("|"));
  const written = f.db.rows("reroute_events");
  assert.equal(written.length, rows.length, run.notes.join("|"));
  for (const r of written) {
    assert.ok(r.source_id, "every row carries the advisory it was authored from");
    assert.ok(["suez", "cape_of_good_hope"].includes(String(r.route_via)));
    assert.equal(r.fuel_burn_multiplier ?? null, null);
  }
  const genoa = written.filter((r) => r.baseline_corridor_id === corridors[1]?.entity_id);
  assert.deepEqual([...new Set(genoa.map((r) => r.route_via))].sort(), ["cape_of_good_hope", "suez"], "the same port pair by Suez and by the Cape is two rows");
  assert.ok(genoa.every((r) => r.reroute_corridor_id === r.baseline_corridor_id), "corridor identity is unchanged: one entity for both routes");
});

test("INV-ARM-7: a second apply writes no duplicate in statutory_computations, reroute_events, indexation_clauses or auxiliary_energy_profiles", async () => {
  const stat = rowsOf(STAT);
  const reroute = rowsOf(REROUTE);
  const f = fixture({ routes: { ...routesFor(stat), ...routesFor(reroute) } });
  Object.assign(f.d.producers.env, { STATUTORY_PRODUCER_SCHEDULES_ENABLED: "1", MARKET_PRODUCER_REROUTE_ROWS_ENABLED: "1", MARKET_PRODUCER_INDEXATION_ROWS_ENABLED: "1", OPERATIONS_PRODUCER_AUX_ENERGY_ROWS_ENABLED: "1" });
  f.db.seed("entities", [...corridors, { entity_id: "cl:instrument:00000000000000aa", kind: "instrument", canonical_name: "VLSFO" }]);
  const aux = "load_type,kw_draw,duty_cycle,hours_typical\nreefer_genset,12,0.5,10\n";
  const clause = "index_id,base_value,base_date,passthrough_pct,review_cadence,rounding_rule\ncl:instrument:00000000000000aa,500,2026-01-01,80,quarterly,nearest USD 1\n";
  const once = async () => {
    await applyText(f, "statutory-schedules", textOf(stat));
    await applyText(f, "reroute-rows", textOf(reroute));
    await runProducer(f.d.producers, { spec: auxiliaryEnergyRows, dry: false, text: aux, orgId: "org-1" });
    await runProducer(f.d.producers, { spec: indexationRows, dry: false, text: clause, orgId: "org-1" });
    return ["statutory_computations", "reroute_events", "indexation_clauses", "auxiliary_energy_profiles"].map((t) => f.db.rows(t).length);
  };
  const first = await once();
  assert.deepEqual(first, [stat.length, reroute.length, 1, 1]);
  assert.deepEqual(await once(), first, "the second apply wrote nothing");
});

test("captureCited reaches an EUR-Lex instrument through Cellar (the family its CELEX key names), and a page the host walls off through the browser tier", async () => {
  const eur = "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32023R1805";
  const walled = "https://www.hapag-lloyd.com/en/services-information/news/2026/09/routing-update.html";
  const quote = "Following a careful assessment of the current security situation in the Red Sea area, these services transition to sailing via the Red Sea route.";
  const page = `<html><body><p>${filler}</p><p>${quote}</p></body></html>`;
  const f = fixture({ routes: { "https://publications.europa.eu/resource/celex/32023R1805": () => new Response(`${filler}\nreference value of 91,16 grams of CO 2 equivalent per MJ\n${filler}`, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }), [walled]: () => new Response("Access Denied", { status: 403 }) } });
  const browser = { newContext: async () => ({ route: async () => undefined, newPage: async () => ({ on: () => undefined, goto: async () => ({ status: () => 200 }), content: async () => page, url: () => walled, waitForTimeout: async () => undefined, close: async () => undefined }), close: async () => undefined }), close: async () => undefined };
  Object.assign(f.d.fetch, { launchBrowser: async () => browser, resolveHost: async () => ["93.184.216.34"] });
  const r = await captureCited(f.d, [{ url: eur, title: "FuelEU Maritime" }, { url: walled, title: "Routing update" }], true);
  assert.equal(r.counts.captured, 2, r.notes.join("|"));
  assert.ok(f.requests.urls.includes("https://publications.europa.eu/resource/celex/32023R1805"));
  assert.ok(!f.requests.urls.includes(eur), "EUR-Lex's own page (its robot gate) was never asked");
  const stored = f.db.rows("agent_run_searches");
  assert.ok(stored.some((s) => s.result_url === walled && String(s.result_content).includes(quote)), "the browser tier's text is stored under the cited URL");
});

test("S4: ecb-fx and the UKPN heatmap name a licence key the register holds as permitted (INV-ARM-1 covers them), and migration 0125 is the register's rendering", () => {
  const f = fixture();
  assert.equal(f.d.catalog["ecb-fx"]?.licenceKey, "ecb");
  assert.equal(f.d.catalog["ukpn-capacity-heatmap"]?.licenceKey, "ukpn_ltds_capacity_heatmap");
  for (const k of ARM2_KEYS) assert.deepEqual(licenceGate(k), { ok: true }, k);
  const repo = (rel: string): URL => new URL(`../../${rel}`, import.meta.url);
  if (process.env.GOLDEN_WRITE_MIGRATION === "1") {
    writeFileSync(repo(ARM2_MIGRATION_FILE), renderArm2Migration());
    writeFileSync(repo(ARM2_DOWN_FILE), renderArm2Down());
  }
  const onDisk = (rel: string): string => (existsSync(repo(rel)) ? readFileSync(repo(rel), "utf8").replace(/\r\n/g, "\n") : "(absent)");
  assert.equal(onDisk(ARM2_MIGRATION_FILE), renderArm2Migration(), "0125 drifted from the register; regenerate with GOLDEN_WRITE_MIGRATION=1 npm test");
  assert.equal(onDisk(ARM2_DOWN_FILE), renderArm2Down());
});
