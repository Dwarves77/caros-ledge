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
import { runPropagate } from "@/core/turn";

import { fixture } from "../integration/world.ts";

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
  for (const s of specs.filter((x) => x.enabled)) assert.match(s.enabledRuling ?? "", /^operator 2026-10-23: population hold lifted for the structured-data producers/, s.name);
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
    for (const r of rowsOf(f)) {
      for (const k of ["url", "title", "retrieved_at", "quote"]) assert.ok(r.citation[k]?.trim(), `${f}: citation.${k}`);
      assert.equal(r.citation.retrieved_at, "2026-10-24");
      assert.notEqual(classTierForHost(hostOf(r.citation.url as string) as string, r.citation.title), null, r.citation.url);
    }
  }
});

test("INV-ARM-2 and INV-ARM-3: the propagate stage captures the cited pages, then writes each row with its registered source and a quote that stands verbatim in the stored capture; a second apply writes nothing twice", async () => {
  const rows = rowsOf(OEM);
  const pages = new Map<string, string>();
  for (const r of rows) pages.set(r.citation.url as string, `${pages.get(r.citation.url as string) ?? ""}
${r.citation.quote}`);
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
