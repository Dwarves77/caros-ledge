// ARM-1: the structured-data producers are armed (ADR-023 code change), their licence verdicts gate the runner (INV-ARM-1), a rows file's cited quotes are captured and verified before a row is written
// (INV-ARM-2), a second apply writes nothing twice (INV-ARM-3), and every table the pattern engine joins has a producer armed here or a stated absence (INV-ARM-4).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { licenceGate } from "@/core/contracts";
import type { FamilyCall } from "@/core/harness";
import { acceptStoredQuote } from "@/core/producers/quote";
import { loadProducerRegistry } from "@/core/producers/registry";
import { citedPages } from "@/core/producers/rows-file";
import { runProducer, type ProducerSpec } from "@/core/producers/runner";
import { hostOf } from "@/core/shared";
import { classTierForHost } from "@/core/sources";
import { runPropagate, runTurn } from "@/core/turn";

import { fixture, NOW } from "../integration/world.ts";

import { makeDeps } from "./support.ts";

interface Plan {
  dispatches: Array<{ producer: string; rowsFile?: string }>;
  tables: Record<string, { armed?: string[]; absent?: Array<{ source: string; reason: string }>; turnPass?: string }>;
  stillDisabled: string[];
}
const plan = JSON.parse(readFileSync("tests/producers/arm-plan.json", "utf8")) as Plan;
const OEM = "src/features/market/producers/data/rows/oem_tech_roadmaps-2026-10.json";
const call = (over: Partial<FamilyCall>): FamilyCall => ({ mode: "apply", dry: false, input: {}, runId: "r0000000-0000-4000-8000-000000000001", rootRunId: "r0000000-0000-4000-8000-000000000001", ...over }) as FamilyCall;
type Row = Record<string, unknown> & { citation: Record<string, string> };
/** Every verbatim quote a row cites (the quote and the further quotes of its citation): the fixture captures hold all of them, and a typed value must stand in one. */
const quotesOf = (r: Row): string => [r.citation.quote, ...((r.citation as unknown as { also?: string[] }).also ?? [])].join(String.fromCharCode(10));
const rowsOf = (path: string): Row[] => (JSON.parse(readFileSync(path, "utf8")) as { rows: Row[] }).rows;
const spine = (rows: Row[]) => [...new Set(rows.map((r) => r.manufacturer_name as string))].map((m, i) => ({ entity_id: `cl:organisation:${String(i).padStart(16, "0")}`, kind: "organisation", canonical_name: m }));

test("INV-ARM-1: an armed spec whose licence verdict is not permitted is refused by the runner; every armed spec in the catalog names no key or a permitted one, and the held specs stay disabled", async () => {
  const armed = (licenceKey: string): ProducerSpec => ({ name: "t", table: "market_series", licenceKey, enabled: true, killSwitchEnv: "T_ON", fetchDoc: async () => ({ text: "doc" }), parse: () => ({ rows: [], warnings: [] }) });
  for (const key of ["sbti_dashboard", "worldbank_cppi", "consilium_europa_eu", "nope_not_registered"]) {
    const r = await runProducer(makeDeps({ env: { T_ON: "1" } }).deps, { spec: armed(key), dry: false, text: "doc" });
    assert.equal(r.outcome, "failed", key);
    assert.match(r.notes[0] as string, /licence block/, key);
  }
  const cat = fixture().d.catalog;
  const specs = Object.values(cat);
  for (const s of specs.filter((x) => x.enabled && x.licenceKey)) assert.deepEqual(licenceGate(s.licenceKey as string), { ok: true }, s.name);
  for (const name of plan.stillDisabled) assert.equal(cat[name]?.enabled ?? false, false, name);
  for (const s of specs.filter((x) => x.enabled)) assert.match(s.enabledRuling ?? "", /^(operator 2026-10-23: population hold lifted for the structured-data producers|operator and scope reviewer 2026-10-26 under ADR-053 section 2 \(DOC-DATE-1\))/, s.name);
});

test("INV-ARM-4: every table the pattern engine joins has a producer armed here that the registry and the catalog agree on, a turn pass, or a stated absence with a reason; a table with none fails", () => {
  const cat = fixture().d.catalog;
  const entries = loadProducerRegistry(cat);
  const tables = ["market_series", "market_series_items", "published_price_statistics", "grid_connection_queues", "regional_data_facts", "state_cost_facts", "oem_tech_roadmaps", "reroute_events", "indexation_clauses", "auxiliary_energy_profiles", "statutory_computations", "research_assessments_current", "signposts", "vocabulary_terms", "vocabulary_mentions", "entity_refs"];
  assert.deepEqual(Object.keys(plan.tables).sort(), [...tables].sort());
  for (const t of tables) {
    const row = plan.tables[t] as Plan["tables"][string];
    for (const name of row.armed ?? []) assert.ok(cat[name]?.enabled && entries.some((e) => e.name === name), `${t}: ${name} is armed and registered`);
    for (const a of row.absent ?? []) assert.ok(a.source && a.reason.length > 20, `${t}: a stated absence names its source and its reason`);
    assert.ok((row.armed?.length ?? 0) + (row.absent?.length ?? 0) + (row.turnPass ? 1 : 0) > 0, `${t} has neither a producer nor a stated absence`);
  }
  for (const d of plan.dispatches) assert.ok(entries.some((e) => e.name === d.producer), d.producer);
});

test("a rows file: every row cites a page the class table rates, with a real retrieved_at and a quote; every file under data/rows is in the staged dispatch list", () => {
  const files = ["market", "operations", "statutory"].flatMap((f) => {
    const dir = `src/features/${f}/producers/data/rows`;
    try {
      return readdirSync(dir).map((n) => `${dir}/${n}`);
    } catch {
      return [];
    }
  });
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.ok(plan.dispatches.some((d) => d.rowsFile === f), `${f} is staged`);
    for (const raw of rowsOf(f)) {
      // A state cost candidate cites its page as source_url and its sentence as span_text (the producer grounds it on the live page before it rates the host).
      const r = raw.citation ? raw : ({ ...raw, citation: { url: raw.source_url, title: raw.source_name, retrieved_at: "2026-10-24", quote: raw.span_text } } as Row);
      for (const k of ["url", "title", "retrieved_at", "quote"]) assert.ok(r.citation[k]?.trim(), `${f}: citation.${k}`);
      assert.equal(r.citation.retrieved_at, "2026-10-24");
      if (r.target_year !== undefined) assert.ok(quotesOf(r).includes(String(r.target_year)), `${f}: target_year ${String(r.target_year)} is not in its quote`);
      assert.notEqual(classTierForHost(hostOf(r.citation.url as string) as string, r.citation.title), null, r.citation.url);
    }
  }
});

test("INV-ARM-2 and INV-ARM-3: the propagate stage captures the cited pages, then writes each row with its registered source and a quote that stands verbatim in the stored capture; a second apply writes nothing twice", async () => {
  const rows = rowsOf(OEM);
  const pages = new Map<string, string>();
  for (const r of rows) pages.set(r.citation.url as string, `${pages.get(r.citation.url as string) ?? ""}
${quotesOf(r)}`);
  const filler = "Notice. This page is provided for information and is reproduced here for the fixture. ".repeat(20);
  const routes = Object.fromEntries([...pages].map(([url, quote]) => [url, () => new Response(`${filler}\n${quote}\n${filler}`, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })]));
  const f = fixture({ routes });
  Object.assign(f.d.producers.env, { OEM_PRODUCER_ROWS_FILE_ENABLED: "1" });
  f.db.seed("entities", spine(rows));
  const input = { producers: { only: "oem-roadmap-rows", rowsFile: OEM } };
  const dry = await runPropagate(call({ mode: "dry", dry: true, input }), f.d);
  assert.equal(dry.counts["producers_oem-roadmap-rows.parsed"], rows.length, dry.notes.join("|"));
  assert.equal(f.db.rows("oem_tech_roadmaps").length, 0, "a dry run writes nothing");
  assert.equal(f.db.rows("agent_run_searches").length, 0, "a dry run captures nothing");
  const first = await runPropagate(call({ input }), f.d);
  assert.equal(f.db.rows("oem_tech_roadmaps").length, rows.length, first.notes.join("|"));
  assert.equal(first.counts.producers_capture_captured, pages.size);
  for (const row of f.db.rows("oem_tech_roadmaps")) assert.ok(row.source_id, "every written row carries its source id");
  for (const r of rows) assert.equal((await acceptStoredQuote(f.d.sb, { url: r.citation.url as string, quote: r.citation.quote as string, verifiedAt: "2026-10-24", now: new Date("2026-10-24T12:00:00Z") })).ok, true, r.citation.url);
  const again = await runPropagate(call({ input }), f.d);
  assert.equal(f.db.rows("oem_tech_roadmaps").length, rows.length, "a second apply writes no duplicate");
  assert.equal(again.counts.producers_capture_unchanged, pages.size);
});

test("INV-JOIN-4: a stored roadmap row whose capture states a target year gets it on the next apply of the rows file (the typed column is patched, never retyped), and a row whose capture states none stays null", async () => {
  const rows = rowsOf(OEM);
  const pages = new Map<string, string>();
  for (const r of rows) pages.set(r.citation.url as string, `${pages.get(r.citation.url as string) ?? ""}
${quotesOf(r)}`);
  const filler = "Notice. This page is provided for information and is reproduced here for the fixture. ".repeat(20);
  const routes = Object.fromEntries([...pages].map(([url, quote]) => [url, () => new Response(`${filler}
${quote}
${filler}`, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })]));
  const f = fixture({ routes });
  Object.assign(f.d.producers.env, { OEM_PRODUCER_ROWS_FILE_ENABLED: "1" });
  f.db.seed("entities", spine(rows));
  const input = { producers: { only: "oem-roadmap-rows", rowsFile: OEM } };
  await runPropagate(call({ input }), f.d);
  const stored = f.db.rows("oem_tech_roadmaps");
  assert.equal(stored.length, rows.length);
  for (const row of stored) row.target_year = null; // the rows as the first pass stored them, before the file stated their years
  const again = await runPropagate(call({ input }), f.d);
  const years = f.db.rows("oem_tech_roadmaps").map((r) => r.target_year ?? null).sort();
  assert.deepEqual(years, [2027, 2027, null, null, null, null], again.notes.join("|"));
  assert.equal(f.db.rows("oem_tech_roadmaps").length, rows.length, "a patch writes no duplicate");
});

test("a page that refuses capture leaves its rows refused by name and nothing written; a rowsFile outside a producer's data/rows directory is refused", async () => {
  const rows = rowsOf(OEM);
  const f = fixture();
  Object.assign(f.d.producers.env, { OEM_PRODUCER_ROWS_FILE_ENABLED: "1" });
  f.db.seed("entities", spine(rows));
  const r = await runPropagate(call({ input: { producers: { only: "oem-roadmap-rows", rowsFile: OEM } } }), f.d);
  assert.equal(f.db.rows("oem_tech_roadmaps").length, 0);
  assert.equal(r.counts.producers_capture_failed, citedPages(readFileSync(OEM, "utf8")).length);
  assert.match(r.notes.join("|"), /quote_not_in_capture/);
  const out = await runPropagate(call({ input: { producers: { only: "oem-roadmap-rows", rowsFile: "package.json" } } }), f.d);
  assert.match(out.notes.join("|"), /not a file under a producer's data\/rows directory/);
});

test("a manufacturer named by its rated citation host is minted once by the organisation path on apply (entity, HOST identifier, the source linked) and the row resolves; a dry run mints nothing", async () => {
  const rows = rowsOf(OEM);
  const hosts = [...new Set(rows.map((r) => r.manufacturer_name as string))];
  const unknown = "neste.com";
  assert.ok(hosts.includes(unknown));
  const pages = new Map<string, string>();
  for (const r of rows) pages.set(r.citation.url as string, `${pages.get(r.citation.url as string) ?? ""}
${quotesOf(r)}`);
  const filler = "Notice. This page is provided for information and is reproduced here for the fixture. ".repeat(20);
  const routes = Object.fromEntries([...pages].map(([url, quote]) => [url, () => new Response(`${filler}
${quote}
${filler}`, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })]));
  const f = fixture({ routes });
  Object.assign(f.d.producers.env, { OEM_PRODUCER_ROWS_FILE_ENABLED: "1" });
  f.db.seed("entities", hosts.filter((h) => h !== unknown).map((m, i) => ({ entity_id: `cl:organisation:${String(i).padStart(16, "0")}`, kind: "organisation", canonical_name: m })));
  const input = { producers: { only: "oem-roadmap-rows", rowsFile: OEM } };
  const dry = await runPropagate(call({ mode: "dry", dry: true, input }), f.d);
  assert.equal(dry.counts["producers_oem-roadmap-rows.parsed"], rows.length, "the unknown host parses as a row to be minted");
  assert.equal(f.db.rows("entities").filter((e) => e.kind === "organisation").length, hosts.length - 1, "dry mints nothing");
  await runPropagate(call({ input }), f.d);
  const orgs = f.db.rows("entities").filter((e) => e.kind === "organisation");
  assert.equal(orgs.length, hosts.length, "exactly one organisation entity was minted");
  const minted = orgs.find((e) => e.canonical_name === unknown);
  assert.ok(minted);
  assert.equal(f.db.rows("entity_identifiers").filter((i) => i.entity_id === minted.entity_id && i.scheme === "HOST" && i.value === unknown).length, 1);
  assert.ok(f.db.rows("sources").some((s) => s.organisation_entity_id === minted.entity_id), "the rated source is linked to the minted organisation");
  assert.equal(f.db.rows("oem_tech_roadmaps").length, rows.length);
  assert.ok(f.db.rows("oem_tech_roadmaps").some((r) => r.manufacturer_id === minted.entity_id));
  await runPropagate(call({ input }), f.d);
  assert.equal(f.db.rows("entities").filter((e) => e.kind === "organisation").length, hosts.length, "a second apply mints nothing");
});

const RULING = "operator 2026-10-23 ruling 1: population hold lifted for the structured-data producers (rulings-2026-10-11.md)";
const turn = (f: ReturnType<typeof fixture>, mode: "dry" | "apply", propagate: Record<string, unknown>) => runTurn({ stage: "propagate", mode, chain: false, input: { propagate } }, { d: f.d, env: {}, now: () => NOW });
const ECB = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

test("a cadence exception carries one ruling into one apply run: without it the producers step stays planned, with it the producer fetches and the ledger row records the text and the producers covered; a dry call only records it; system_state is never touched", async () => {
  const closed = fixture({ cadence: "off" });
  const before = JSON.stringify(closed.db.rows("system_state"));
  await turn(closed, "apply", { producers: { only: "ecb-fx" } });
  assert.equal(closed.requests.urls.length, 0, "no exception: planned, not fetched");
  await turn(closed, "apply", { producers: { only: "ecb-fx" }, cadence_exception: "   " });
  assert.equal(closed.requests.urls.length, 0, "a blank exception is none");
  await turn(closed, "dry", { producers: { only: "ecb-fx" }, cadence_exception: RULING });
  assert.equal(closed.requests.urls.length, 0, "dry: recorded, nothing fetches");
  const dryRow = closed.db.rows("harness_runs").find((r) => r.family === "propagation" && r.mode === "dry" && (r.inputs as Record<string, unknown>).cadence_exception === RULING);
  assert.match(JSON.stringify(dryRow?.outputs), /cadence exception recorded \(dry: nothing fetched\)/);
  const r = await turn(closed, "apply", { producers: { only: "ecb-fx" }, cadence_exception: RULING });
  assert.ok(closed.requests.urls.includes(ECB), "the ruled apply fetched");
  const row = closed.db.rows("harness_runs").find((x) => x.family === "propagation" && x.mode === "apply" && (x.inputs as Record<string, unknown>).cadence_exception === RULING);
  assert.ok(row, "the ledger row carries the ruling in its inputs");
  assert.match(JSON.stringify(row?.outputs), /cadence exception in force for this call only: .*operator 2026-10-23 ruling 1.*producers covered: ecb-fx/);
  assert.equal(r.runs.length, 1);
  assert.equal(JSON.stringify(closed.db.rows("system_state")), before, "the exception never changes system_state");
  assert.equal(closed.db.rows("system_state")[0]?.scrape_cadence, "off");
});

test("a ruled apply under a closed gate also captures the cited pages, so a rows file lands with its quotes verified", async () => {
  const rows = rowsOf(OEM);
  const pages = new Map<string, string>();
  for (const r of rows) pages.set(r.citation.url as string, `${pages.get(r.citation.url as string) ?? ""}
${quotesOf(r)}`);
  const filler = "Notice. This page is provided for information and is reproduced here for the fixture. ".repeat(20);
  const routes = Object.fromEntries([...pages].map(([url, quote]) => [url, () => new Response(`${filler}
${quote}
${filler}`, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })]));
  const f = fixture({ cadence: "off", routes });
  Object.assign(f.d.producers.env, { OEM_PRODUCER_ROWS_FILE_ENABLED: "1" });
  const none = await turn(f, "apply", { producers: { only: "oem-roadmap-rows", rowsFile: OEM } });
  assert.equal(none.exit, 0);
  assert.equal(f.db.rows("oem_tech_roadmaps").length, 0, "closed gate, no exception: nothing captured, nothing written");
  assert.equal(f.requests.urls.length, 0);
  await turn(f, "apply", { producers: { only: "oem-roadmap-rows", rowsFile: OEM }, cadence_exception: RULING });
  assert.equal(f.db.rows("oem_tech_roadmaps").length, rows.length);
  assert.equal(f.db.rows("system_state")[0]?.scrape_cadence, "off");
});
