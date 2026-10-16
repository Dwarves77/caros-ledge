// The producer runner and its core helpers: the gate matrix, the dry-run invariants, the fetch policy, the keyed planner, the registry, the CSV reader, OpenAlex, rows files, labels.
import assert from "node:assert/strict";
import { test } from "node:test";

import { readCsvStream, splitCsvText } from "@/core/csv/stream";
import { decideDrainSwitch, readDrainSwitch } from "@/core/drain/switch";
import { openAlexGet, searchWorks, workByDoi } from "@/core/http/openalex";
import { loadProducerRegistry, runRegistered, selectRuns } from "@/core/producers/registry";
import { entityRefValuesForTable, loadRowsFile, parseOperatorRows, registerCitedSource, requireCitation, resolveEntityByName, RowsFileError, validateEntityRefs } from "@/core/producers/rows-file";
import { decideApply, licenceBlockOf, makeGetter, NetworkError, runProducer, type ProducerSpec } from "@/core/producers/runner";
import { foldProducerSummaries, writeProducerSummary } from "@/core/producers/summary";
import { KEYS, planKeyedUpsert } from "@/core/producers/upsert-plan";
import { labelled, missing, spec09Label } from "@/core/values/label";

import { memoryDb } from "../_support/memory-db.ts";

import { makeDeps, NOW } from "./support.ts";

const spec = (over: Partial<ProducerSpec> = {}): ProducerSpec => ({
  name: "t", table: "market_series", licenceKey: null, enabled: true, killSwitchEnv: "T_ON",
  async fetchDoc() { return { text: "x" }; },
  parse: () => ({ rows: [{ series_key: "t:a", reference_period: "2026-10-01", value_numeric: 1 }], warnings: [] }),
  plan: { read: async (sb) => ((await sb.from("market_series").select("*")).data ?? []) as never, key: KEYS.seriesPeriod, patchable: ["value_numeric"], pk: "id" },
  ...over,
});

test("the gate matrix: apply x licenceBlock x enabled x killSwitchOn x hasCreds x truncated, canWrite only when every gate passes, and the reason names the FIRST failing gate in the fixed order", () => {
  let writable = 0;
  for (let m = 0; m < 64; m += 1) {
    const g = { apply: !!(m & 1), licenceBlock: m & 2 ? "blocked" : null, enabled: !!(m & 4), killSwitchOn: !!(m & 8), hasCreds: !!(m & 16), truncated: !!(m & 32) };
    const d = decideApply(g);
    const expect = g.apply && !g.licenceBlock && g.enabled && g.killSwitchOn && g.hasCreds && !g.truncated;
    assert.equal(d.canWrite, expect, JSON.stringify(g));
    if (expect) writable += 1;
    if (!g.apply) assert.match(d.reason, /dry run/);
    else if (g.licenceBlock) assert.match(d.reason, /licence block/);
    else if (!g.enabled) assert.match(d.reason, /ENABLED/);
    else if (!g.killSwitchOn) assert.match(d.reason, /kill switch/);
    else if (!g.hasCreds) assert.match(d.reason, /credentials/);
    else if (g.truncated) assert.match(d.reason, /byte-limited/);
  }
  assert.equal(writable, 1);
});

test("INV-246/045: a dry run performs zero writes, zero existing-row reads and no fetch when the document is injected; and it needs no credentials", async () => {
  const { deps, mem, calls } = makeDeps({ noDb: true, env: {} });
  const r = await runProducer(deps, { spec: spec(), text: "doc" });
  assert.equal(r.outcome, "ok");
  assert.equal(r.counts.parsed, 1);
  assert.match(r.notes.join(" "), /existing rows are not read/);
  assert.equal(mem.writes.length, 0);
  assert.equal(mem.reads.length, 0);
  assert.equal(calls.length, 0);
  const withDb = makeDeps({});
  await runProducer(withDb.deps, { spec: spec(), text: "doc" });
  assert.equal(withDb.mem.writes.length + withDb.mem.reads.length, 0, "even with a database the dry run touches nothing");
});

test("INV-046: the kill switch (and every gate) is read BEFORE the first fetch: a refused apply costs no request and writes nothing", async () => {
  const { deps, mem, calls } = makeDeps({ routes: { "https://x/": "doc" } });
  const s = spec({ async fetchDoc(ctx) { return { text: await (await ctx.get("https://x/")).text() }; } });
  const off = await runProducer(deps, { spec: s, dry: false });
  assert.equal(off.outcome, "failed");
  assert.match(off.notes[0] as string, /kill switch/);
  assert.equal(calls.length, 0);
  const disabled = await runProducer(makeDeps({ env: { T_ON: "1" }, routes: { "https://x/": "doc" } }).deps, { spec: spec({ enabled: false }), dry: false });
  assert.match(disabled.notes[0] as string, /ENABLED/);
  const blocked = await runProducer(makeDeps({ env: { T_ON: "1" } }).deps, { spec: spec({ licenceBlock: "no redistribution" }), dry: false, text: "doc" });
  assert.match(blocked.notes[0] as string, /licence block/);
  assert.equal(mem.writes.length, 0);
});

test("INV-245: a prohibited-redistribution source (the register's sbti_dashboard) is licence-blocked whatever the other gates say; an unregistered or permitted key is not", () => {
  assert.match(licenceBlockOf({ licenceKey: "sbti_dashboard" }) ?? "", /prohibited/);
  assert.equal(licenceBlockOf({ licenceKey: "eia" }), null);
  assert.equal(licenceBlockOf({ licenceKey: null }), null);
  assert.equal(licenceBlockOf({ licenceKey: "nope_not_registered" }), null);
  assert.equal(decideApply({ apply: true, licenceBlock: "x", enabled: true, killSwitchOn: true, hasCreds: true }).canWrite, false);
});

test("an apply that passes every gate writes through the keyed plan, records the run once, and a missing key (the EIA free key) is a credentials refusal", async () => {
  const ok = makeDeps({ env: { T_ON: "1" } });
  const r = await runProducer(ok.deps, { spec: spec(), dry: false, text: "doc" });
  assert.equal(r.outcome, "ok");
  assert.equal(r.counts.created, 1);
  assert.equal(ok.mem.tables.market_series?.length, 1);
  assert.equal(ok.runs.length, 1);
  assert.equal(ok.runs[0]?.family, "producers");
  const again = await runProducer(ok.deps, { spec: spec(), dry: false, text: "doc" });
  assert.equal(again.counts.created, 0, "an unchanged re-run writes nothing");
  const noKey = await runProducer(makeDeps({ env: { T_ON: "1" } }).deps, { spec: spec({ keyEnv: "SOME_KEY" }), dry: false, text: "doc" });
  assert.match(noKey.notes[0] as string, /credentials/);
  const truncated = await runProducer(makeDeps({ env: { T_ON: "1" } }).deps, { spec: spec({ parse: () => ({ rows: [{ series_key: "a", reference_period: "p" }], warnings: [], truncated: true }) }), dry: false, text: "doc" });
  assert.match(truncated.notes[0] as string, /byte-limited/);
});

test("a downstream that throws fails the run closed (rule 17), and the failed read of existing rows is a failed run, never an empty plan", async () => {
  const d = makeDeps({ env: { T_ON: "1" } });
  const r = await runProducer(d.deps, { spec: spec({ after: async () => { throw new Error("no edges authored"); } }), dry: false, text: "doc" });
  assert.equal(r.outcome, "failed");
  assert.match(r.notes.join(" "), /no edges authored/);
  const e = makeDeps({ env: { T_ON: "1" }, db: memoryDb({}, { failures: [{ table: "market_series", op: "select", message: "boom" }] }) });
  const failedRead = await runProducer(e.deps, { spec: spec({ plan: { read: async (sb) => { const { data, error } = await sb.from("market_series").select("*"); if (error) throw new Error(error.message); return data ?? []; }, key: KEYS.seriesPeriod, patchable: [], pk: "id" } }), dry: false, text: "doc" });
  assert.equal(failedRead.outcome, "failed");
  assert.equal(e.mem.writes.filter((w) => w.op === "insert").length, 0);
});

test("B-0324: no runtime calls process.exit; an input that is empty is a returned failure (or a recorded gap when the spec has one), never an exit", async () => {
  const d = makeDeps({ noDb: true });
  const r = await runProducer(d.deps, { spec: spec(), text: "   " });
  assert.equal(r.outcome, "failed");
  const gap = await runProducer(d.deps, { spec: spec({ gap: "no rows file given" }), text: "" });
  assert.equal(gap.outcome, "ok");
  assert.match(gap.notes[0] as string, /gap: no rows file given/);
});

test("the fetch policy: one retry policy (network error, 429, 5xx), no retry on a 4xx, the Range header, and the key is redacted from the error", async () => {
  let n = 0;
  const flaky = async (): Promise<Response> => (++n < 3 ? new Response("busy", { status: 503 }) : new Response("fine", { status: 200 }));
  const get = makeGetter(flaky as never, { sleep: async () => {} });
  assert.equal(await (await get("https://h/x")).text(), "fine");
  assert.equal(n, 3);
  let m = 0;
  const gone = makeGetter((async () => (m++, new Response("x", { status: 404 }))) as never, { sleep: async () => {} });
  await assert.rejects(() => gone("https://h/x?api_key=SECRET123"), (e: Error) => e instanceof NetworkError && !e.message.includes("SECRET123") && e.message.includes("REDACTED"));
  assert.equal(m, 1, "a 404 is not retried");
  let seen: Record<string, string> | undefined;
  await makeGetter((async (_u: string, init: { headers?: Record<string, string> }) => ((seen = init.headers), new Response("p", { status: 206 }))) as never)("https://h/y", { range: [0, 99] });
  assert.equal(seen?.Range, "bytes=0-99");
});

test("the keyed planner across the four key shapes: create what is new, patch only what differs, count unchanged, skip a null key", () => {
  const cases = [
    { key: KEYS.seriesPeriod, a: { series_key: "s", reference_period: "2026-01-01", v: 1 }, b: { series_key: "s", reference_period: "2026-01-01", v: 2 }, missing: { series_key: "s", reference_period: null, v: 1 } },
    { key: KEYS.regionDimensionLabel, a: { region_id: "r", dimension: "d", fact_label: "l", v: 1 }, b: { region_id: "r", dimension: "d", fact_label: "l", v: 2 }, missing: { region_id: null, dimension: "d", fact_label: "l", v: 1 } },
    { key: KEYS.dsoSubstationAsOf, a: { dso_name: "x", substation_ref: "S", as_of: "2026-01-01", v: 1 }, b: { dso_name: "x", substation_ref: "S", as_of: "2026-01-01", v: 2 }, missing: { dso_name: "x", substation_ref: null, as_of: "2026-01-01", v: 1 } },
    { key: KEYS.manufacturerTechSource, a: { manufacturer_id: "m", tech_category: "t", source_id: "s", v: 1 }, b: { manufacturer_id: "m", tech_category: "t", source_id: "s", v: 2 }, missing: { manufacturer_id: "m", tech_category: "t", source_id: null, v: 1 } },
  ];
  for (const c of cases) {
    const existing = [{ id: 7, ...c.a }];
    const plan = planKeyedUpsert(existing, [c.b, { ...c.a, v: 1 }, c.missing, { ...c.b, k: "new", [Object.keys(c.a)[0] as string]: "other" }], { key: c.key, patchable: ["v"], pk: "id" });
    assert.equal(plan.toUpdate.length, 1);
    assert.deepEqual(plan.toUpdate[0]?.patch, { v: 2 });
    assert.equal(plan.toUpdate[0]?.pk, 7);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.toCreate.length, 1);
    const same = planKeyedUpsert(existing, [c.a], { key: c.key, patchable: ["v"], pk: "id" });
    assert.equal(same.unchanged, 1);
  }
});

test("the registry: closed field set, duplicates and a bad entity id refused, selection by all / registry / only, an entry that disagrees with its spec refused", () => {
  assert.equal(loadProducerRegistry().length, 7);
  const base = { name: "a-b", domain_table: "market_series", source: "s", licence: "l", dry_capable: true, enabled_env: "A_B", in_all: true };
  assert.throws(() => loadProducerRegistry(undefined, [base, base]), /duplicate/);
  assert.throws(() => loadProducerRegistry(undefined, [{ ...base, extra: 1 }]));
  assert.throws(() => loadProducerRegistry(undefined, [{ ...base, entity_id: "cl:jurisdiction:xyz" }]), /entity_id/);
  assert.throws(() => loadProducerRegistry(undefined, [{ ...base, dry_capable: false }]));
  const entries = loadProducerRegistry();
  assert.deepEqual(selectRuns(entries, { producer: "all" }).map((e) => e.name), ["ecb-fx", "eia-v2-petroleum-spot", "eu-weekly-oil-bulletin"]);
  assert.deepEqual(selectRuns(entries, { producer: "registry", only: "sbti-target-dashboard" }).map((e) => e.name), ["sbti-target-dashboard"]);
  assert.throws(() => selectRuns(entries, { producer: "all", only: "ecb-fx" }), /only applies/);
  assert.throws(() => selectRuns(entries, { producer: "registry", only: "nope" }), /unknown registry producer/);
  assert.deepEqual(selectRuns(entries, { producer: "elsewhere" }), []);
  assert.throws(() => loadProducerRegistry({ "a-b": spec({ table: "other_table", killSwitchEnv: "A_B" }) }, [base]), /disagrees/);
  assert.throws(() => loadProducerRegistry({}, [base]), /no producer spec/);
});

test("runRegistered runs in registry order, stamps only the entry's own entity, and stops at the first failure", async () => {
  const seen: Array<{ name: string; entity: string | null }> = [];
  const mk = (name: string, fail = false): ProducerSpec => spec({ name, killSwitchEnv: null, parse: (_d, ctx) => { seen.push({ name, entity: ctx.entityId }); if (fail) throw new Error("bad"); return { rows: [{ k: name }], warnings: [] }; }, async fetchDoc() { return { text: "x" }; } });
  const entries = [
    { name: "first", domain_table: "market_series", source: "s", licence: "l", dry_capable: true as const, enabled_env: null, in_all: true, entity_id: "cl:jurisdiction:9170a8b2fb3234ba" },
    { name: "second", domain_table: "market_series", source: "s", licence: "l", dry_capable: true as const, enabled_env: null, in_all: true },
    { name: "third", domain_table: "market_series", source: "s", licence: "l", dry_capable: true as const, enabled_env: null, in_all: true },
  ];
  const catalog = { first: mk("first"), second: mk("second", true), third: mk("third") };
  const r = await runRegistered(makeDeps({ noDb: true }).deps, { catalog, entries });
  assert.equal(r.outcome, "failed");
  assert.deepEqual(seen, [{ name: "first", entity: "cl:jurisdiction:9170a8b2fb3234ba" }, { name: "second", entity: null }]);
});

test("the producer summary: no directory writes nothing; a failed status carries its reason; the family fold counts failures and edges", () => {
  assert.equal(writeProducerSummary({ producer: "p", status: "ok", rows_changed: 1, edges_authored: null }), null);
  assert.throws(() => writeProducerSummary({ producer: "p", status: "weird" as never, rows_changed: 1, edges_authored: null }, { dir: "x" }), /status/);
  const mk = (producer: string, status: "ok" | "failed", edges: number | null) => ({ producer, status, rows_changed: 2, edges_authored: edges, reason: status === "failed" ? "no edges" : null, counts: {}, written_at: NOW.toISOString() });
  const f = foldProducerSummaries([mk("a", "ok", 3), mk("b", "failed", 0), mk("c", "ok", null)]);
  assert.equal(f.metrics.producers_failed, 1);
  assert.equal(f.metrics.edges_authored_total, 3);
  assert.equal(f.defects_found.length, 1);
  assert.equal(foldProducerSummaries([]).metrics.producers_reporting, 0);
});

test("the one CSV reader is chunk-safe: a quote, a CRLF and a multibyte character each split across chunks; a byte limit drops the half record; a quoted newline stays one field", async () => {
  const text = 'a,b,c\r\n"x, y","say ""hi""",é\r\n1,2,3\n';
  const all = async (chunks: Array<string | Uint8Array>, o?: { dropTail?: boolean | (() => boolean) }) => { const out: string[][] = []; for await (const r of readCsvStream(chunks, o)) out.push(r); return out; };
  const whole = await all([text]);
  assert.deepEqual(whole, [["a", "b", "c"], ["x, y", 'say "hi"', "é"], ["1", "2", "3"]]);
  const bytes = Buffer.from(text, "utf8");
  for (const cut of [8, 9, 14, 16, 17, bytes.indexOf(0xc3) + 1, bytes.indexOf(0x0d) + 1]) assert.deepEqual(await all([bytes.subarray(0, cut), bytes.subarray(cut)]), whole, `cut at ${cut}`);
  assert.deepEqual(await all(["a,b\n1,2\n3,"], { dropTail: true }), [["a", "b"], ["1", "2"]], "the unterminated tail is dropped on a byte-limited read");
  assert.deepEqual(splitCsvText('H1,H2\n"line one\nline two",x\n').rows, [["line one\nline two", "x"]]);
  assert.deepEqual(splitCsvText("﻿Name,Age\r\n\r\nA,1\r\n").header, ["name", "age"]);
});

test("OpenAlex: the polite mailto comes from the environment (never a literal), 429 backs off and honours Retry-After, 404 is honest absence, a timeout signal is passed", async () => {
  const urls: string[] = [];
  let hit = 0;
  const sleeps: number[] = [];
  const fetch = async (u: string, init?: { signal?: AbortSignal }): Promise<Response> => {
    urls.push(u);
    assert.ok(init?.signal, "every call carries a timeout signal");
    if (u.includes("/works/https://doi.org/10.1/none")) return new Response("", { status: 404 });
    if (++hit === 1) return new Response("", { status: 429, headers: { "retry-after": "2" } });
    return new Response(JSON.stringify({ results: [{ id: "W1" }] }), { status: 200 });
  };
  const deps = { fetch: fetch as never, sleep: async (ms: number) => void sleeps.push(ms), email: "ops@example.test" };
  assert.deepEqual(await searchWorks({ search: "freight" }, deps), { results: [{ id: "W1" }] });
  assert.deepEqual(sleeps, [2000]);
  assert.match(urls[0] as string, /mailto=ops%40example\.test/);
  assert.equal(await workByDoi("doi:10.1/none", deps), null);
  assert.equal(await workByDoi("", deps), null);
  await assert.rejects(() => openAlexGet("/works", {}, { fetch: (async () => new Response("", { status: 500 })) as never, email: null }), /500/);
  const bare: string[] = [];
  delete process.env.OPENALEX_POLITE_EMAIL;
  await openAlexGet("/works", {}, { fetch: (async (u: string) => (bare.push(u), new Response("{}", { status: 200 }))) as never });
  assert.doesNotMatch(bare[0] as string, /mailto/, "no env value means no mailto, never a literal fallback");
  process.env.OPENALEX_POLITE_EMAIL = "env@example.test";
  await openAlexGet("/works", {}, { fetch: (async (u: string) => (bare.push(u), new Response("{}", { status: 200 }))) as never });
  delete process.env.OPENALEX_POLITE_EMAIL;
  assert.match(bare[1] as string, /mailto=env%40example\.test/);
  assert.doesNotMatch(urls.join(" "), /carosledge|@/);
});

test("INV-106: the drain switch fails closed on every layer, reads the pause and the fleet halt, and a missing client or failed read is a halt", async () => {
  assert.equal(decideDrainSwitch({ judgementDrain: "on", emergencyPaused: false, fleetHalted: false }).on, true);
  assert.match(decideDrainSwitch({ judgementDrain: "on", emergencyPaused: true, fleetHalted: false }).reason ?? "", /emergency/);
  assert.match(decideDrainSwitch({ judgementDrain: "on", emergencyPaused: false, fleetHalted: true }).reason ?? "", /fleet-budget-halt is open/);
  assert.match(decideDrainSwitch({ judgementDrain: "off", emergencyPaused: false, fleetHalted: false }).reason ?? "", /judgement_drain is off/);
  assert.equal(decideDrainSwitch({ judgementDrain: "on", emergencyPaused: false, fleetHalted: undefined }).on, false, "anything but a clean false is a halt");
  assert.equal((await readDrainSwitch(null)).on, false);
  const on = memoryDb({ system_state: [{ id: true, judgement_drain: "on", global_processing_paused: false }] });
  assert.equal((await readDrainSwitch(on.db)).on, true);
  const halted = memoryDb({ system_state: [{ id: true, judgement_drain: "on", global_processing_paused: false }], integrity_flags: [{ subject_ref: "fleet-budget-halt", status: "open" }] });
  assert.equal((await readDrainSwitch(halted.db)).on, false);
  const broken = memoryDb({ system_state: [{ id: true, judgement_drain: "on", global_processing_paused: false }] }, { failures: [{ table: "integrity_flags", op: "select", message: "down" }] });
  const s = await readDrainSwitch(broken.db);
  assert.equal(s.on, false);
  assert.equal(s.readFailed, true);
});

test("rows files and the operator contract: a citation is required by name, an unclassifiable host is refused, accept and reject rows, caps, and entity references are validated", async () => {
  assert.throws(() => loadRowsFile("{"), RowsFileError);
  assert.throws(() => loadRowsFile("[]"), /no rows/);
  assert.equal(loadRowsFile('{"rows":[{"a":1}]}').length, 1);
  assert.throws(() => requireCitation({}, 0, "w"), /no citation/);
  assert.throws(() => requireCitation({ citation: { url: "https://a.b/c", title: "t", retrieved_at: "d" } }, 3, "w"), /row\[3\]\.citation\.quote/);
  assert.throws(() => requireCitation({ citation: { url: "nope", title: "t", retrieved_at: "d", quote: "q" } }, 0, "w"), /valid absolute URL/);
  const unk = await registerCitedSource({ url: "https://www.mondaq.com/page", title: "Some page" }, { sb: null });
  assert.equal(unk.refused, true);
  assert.match((unk as { reason: string }).reason, /does not resolve to a codified class/);
  const known = await registerCitedSource({ url: "https://eur-lex.europa.eu/x", title: "Reg" }, { sb: null });
  assert.equal(known.refused, true);
  assert.ok("wouldRegisterTier" in known && typeof known.wouldRegisterTier === "number", "a dry run reports the tier it would register at");
  assert.equal(resolveEntityByName([{ canonical_name: "Acme", entity_id: "e1" }], "Acme"), "e1");
  assert.equal(resolveEntityByName([{ canonical_name: "Acme", entity_id: "e1" }], "acme"), null, "exact match only; never minted");
  // The old fixture CSVs, inline: one accepted row each, and the deliberately invalid rows.
  const aux = "load_type,kw_draw,duty_cycle,hours_typical,node_id\nreefer_genset,12,0.5,10,cl:node:aaaa\nspaceship_climate_control,1,0.5,1,\nreefer_genset,1,1.5,1,\n";
  const a = parseOperatorRows("auxiliary_energy_profiles", aux);
  assert.equal(a.accepted.length, 1);
  assert.equal(a.rejected.length, 2);
  assert.match(a.rejected[0]?.errors[0] as string, /load_type must be one of/);
  assert.match(a.rejected[1]?.errors[0] as string, /duty_cycle must be between 0 and 1/);
  const idx = "index_id,base_value,base_date,passthrough_pct,review_cadence,rounding_rule,cap_pct,floor_pct\nIDX1,100,2026-01-01,50,monthly,round2,5,-5\n,100,2026-01-01,50,monthly,round2,,\nIDX2,100,2026-01-01,50,monthly,round2,1,4\n";
  const i = parseOperatorRows("indexation_clauses", idx);
  assert.equal(i.accepted.length, 1);
  assert.match(i.rejected.map((r) => r.errors.join()).join(), /index_id is required/);
  assert.match(i.rejected.map((r) => r.errors.join()).join(), /floor_pct must be <= cap_pct/);
  assert.equal(parseOperatorRows("nope", idx).ok, false);
  assert.match(parseOperatorRows("indexation_clauses", "a,b\n1,2").error ?? "", /missing required column/);
  assert.match(parseOperatorRows("indexation_clauses", idx, { maxRows: 1 }).error ?? "", /row cap/);
  assert.match(parseOperatorRows("indexation_clauses", idx, { maxBytes: 10 }).error ?? "", /byte cap/);
  const withRefs = parseOperatorRows("indexation_clauses", "index_id,base_value,base_date,passthrough_pct,review_cadence,rounding_rule,corridor_id\nIDX1,1,2026-01-01,50,monthly,r,cl:corridor:zz\n");
  assert.deepEqual([...entityRefValuesForTable("indexation_clauses", withRefs.accepted)].sort(), ["IDX1", "cl:corridor:zz"]);
  const v = validateEntityRefs("indexation_clauses", withRefs.accepted, new Set(["IDX1"]));
  assert.equal(v.valid.length, 0);
  assert.match(v.invalid[0]?.errors.join() ?? "", /corridor_id "cl:corridor:zz" does not match any known entity/);
});

test("spec09 labels: a missing value always carries a reason, an unknown derivation is M, never a guessed bucket", () => {
  assert.equal(spec09Label("statutory_fixed"), "statutory");
  assert.equal(spec09Label("calculated"), "estimate");
  assert.equal(spec09Label("nonsense"), "M");
  assert.equal(spec09Label(null), "M");
  assert.throws(() => missing(""), TypeError);
  assert.throws(() => missing("   "), TypeError);
  assert.equal(missing("no source").value, null);
  assert.throws(() => labelled(null, "calculated"), TypeError);
  assert.equal(labelled(3, "calculated", { extra: 1 }).extra, 1);
});
