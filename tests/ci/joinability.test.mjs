// JOIN-1: the joinability gate (scripts/ci/joinability.mjs, scripts/ci/joinability/sample.mjs). Every test plants a violation in a fixture world (a couplings file, a facts file, a catalog and a sample) and asserts the gate names it; the real data files are
// checked by `npm run joinability` and by the last test here. The tests walk the fixture's own tables, classes and columns (Rule 19), and the counts they walked are asserted, so a fixture grown by one table is walked with no edit to a test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { evaluate, j1, j2, ratchet, tablesOf } from "../../scripts/ci/joinability.mjs";
import { codesOf, j3Findings, keyFindings, severityWriters, unitStats } from "../../scripts/ci/joinability/sample.mjs";

const LEGS = ["road", "rail", "ocean", "inland_waterway", "air"];
const entity = (key, cls, over = {}) => ({ key, class: cls, name: key, aliases: [], modes: ["road"], entityId: `cl:x:${key}`, ...over });
const rel = (parent, child, relation = "feedstock_of") => ({ parent, child, relation, citations: [] });

/** A fixture world: three tables (two in facts.json, one only in couplings.json), three classes on two surfaces, a mode lens. */
function world(over = {}) {
  const w = {
    root: ".",
    couplings: {
      classes: { fuel: {}, site: {}, mode: {}, lens: {} },
      entities: [entity("fuel:a", "fuel"), entity("site:b", "site"), entity("mode:road", "mode"), entity("lens:w", "lens", { modes: [] })],
      relations: [rel("fuel:a", "site:b"), rel("site:b", "mode:road", "serves_hub")],
      columns: [{ table: "alpha", pk: "id", maps: [{ column: "owner", by: "entity" }, { column: "label", by: "map", map: { fuel: "fuel:a" } }, { by: "const", entity: "fuel:a" }] }, { table: "gamma", pk: "id", maps: [{ column: "mode", by: "mode" }] }],
    },
    facts: { alpha: { role: "capacity", pk: "id", surface: "market", due: "due", qty: { column: "qty", unitColumn: "unit" }, source: "source_id" }, beta: { role: "ratchet", pk: "id", surface: "regulations", due: "deadline" } },
    cfg: {
      unnormalisedShare: 0.05,
      tables: {
        alpha: { textColumns: ["owner", "label", "unit", "note"], unmapped: { unit: "a unit token the unit normaliser reads, not an entity", note: "free prose written by the reviewer of the row" } },
        beta: { textColumns: ["body", "stage"], unmapped: { body: "the verbatim text of the duty, prose", stage: "the stage token of the row" } },
        gamma: { textColumns: ["mode"], unmapped: {} },
      },
      classes: {
        fuel: { surfaces: ["market"], modes: "required", relations: "required", reach: "required" },
        site: { surfaces: ["operations"], modes: "required", relations: "required", reach: "required" },
        mode: { surfaces: [], modes: "required", relations: "required", reach: "required" },
        lens: { surfaces: [], modes: "exempt", relations: "exempt", reach: "exempt", reason: "a lens carries a unit, not a mode" },
      },
      modeLinks: { fuel: { relation: "consignment_wide", when: "modeAgnostic" } },
      unitColumns: [],
      tokenColumns: [],
      absences: [],
    },
    vocab: { vocabularies: { transport_mode: Object.fromEntries(LEGS.map((c) => [c, { code: c }])), origin_class: { official: { code: "official" }, community: { code: "community" } } }, mode_aliases: { sea: "ocean", truck: "road" } },
    schema: new Map([["alpha", new Set(["id", "owner", "label", "unit", "note", "due", "qty", "source_id"])], ["beta", new Set(["id", "body", "stage", "deadline"])], ["gamma", new Set(["id", "mode"])]]),
    uuids: new Map(),
    legModes: new Set(LEGS),
    exists: (p) => p === "src/real/module.ts",
  };
  return Object.assign(w, over);
}
const keys = (r) => r.findings.map((f) => f.key).sort();
const clone = (w) => ({ ...structuredClone({ ...w, exists: undefined }), exists: w.exists });

test("J1 walks every table the engine joins, derived from facts.json and couplings.json; the clean fixture is clean and the walk is counted", () => {
  const w = world();
  assert.deepEqual(tablesOf(w).sort(), ["alpha", "beta", "gamma"]);
  const r = j1(w);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.walked, { tables: 3, columns: 7 });
});

test("INV-JOIN-1: a pinned text column neither mapped nor listed is red naming table.column; listed with a reason it passes; mapped and listed is a contradiction; a table added to facts.json with no pin fails", () => {
  const w = world();
  for (const [table, pin] of Object.entries(w.cfg.tables)) {
    // the attack, once per table: add a prose column to the pin with no map and no line
    const planted = clone(w);
    planted.schema.get(table).add("planted_prose");
    planted.cfg.tables[table].textColumns.push("planted_prose");
    assert.deepEqual(keys(j1(planted)), [`J1:${table}.planted_prose`], table);
    assert.match(j1(planted).findings[0].msg, new RegExp(`${table}\\.planted_prose: a text column the engine can join on, neither mapped nor listed`));
    // the same column listed with a reason passes
    planted.cfg.tables[table].unmapped = { ...pin.unmapped, planted_prose: "free prose typed by the reviewer of the row" };
    assert.deepEqual(j1(planted).findings, [], table);
  }
  // mapped (alpha.label) and listed: a contradiction
  const both = world();
  both.cfg.tables.alpha.unmapped.label = "the label of the row, listed although the map reads it";
  assert.deepEqual(keys(j1(both)), ["J1:alpha.label"]);
  assert.match(j1(both).findings[0].msg, /mapped in couplings\.json and listed unmapped/);
  // a table added to the fixture facts.json with no pin: the list is derived, so the test adds one, not the script
  const added = world();
  added.facts.delta = { role: "series", pk: "id" };
  assert.deepEqual(tablesOf(added).sort(), ["alpha", "beta", "delta", "gamma"]);
  assert.deepEqual(keys(j1(added)), ["J1:delta"]);
});

test("INV-JOIN-1: a stale map, a stale pin, an empty or n/a reason, and a reason that says a pass mines the column without naming a module that exists are red", () => {
  const stale = world();
  stale.couplings.columns[0].maps.push({ column: "gone", by: "alias" });
  assert.deepEqual(keys(j1(stale)), ["J1:alpha.gone"]);
  const pin = world();
  pin.cfg.tables.beta.textColumns.push("ghost");
  pin.cfg.tables.beta.unmapped.ghost = "a column the pin lists and the schema lacks entirely";
  assert.match(j1(pin).findings[0].msg, /a stale pin/);
  for (const reason of ["n/a", "", "TBD", "short"]) {
    const w = world();
    w.cfg.tables.beta.unmapped.stage = reason;
    assert.deepEqual(keys(j1(w)), ["J1:beta.stage"], JSON.stringify(reason));
  }
  const mines = world();
  mines.cfg.tables.beta.unmapped.body = "prose that a pass mines for entity names";
  assert.match(j1(mines).findings[0].msg, /names no module/);
  mines.cfg.tables.beta.unmapped.body = "prose that a pass mines for entity names (src/missing/none.ts claimRefs)";
  assert.match(j1(mines).findings[0].msg, /src\/missing\/none\.ts, which does not exist/);
  mines.cfg.tables.beta.unmapped.body = "prose that a pass mines for entity names (src/real/module.ts claimRefs)";
  assert.deepEqual(j1(mines).findings, []);
});

test("INV-JOIN-1: a column mapped only by an `alias` map is not mapped: the mining pass matches no words, so the column is red until it has an entity column or a formal-code map", () => {
  const w = world();
  w.couplings.columns[0].maps[1] = { column: "label", by: "alias" };
  assert.deepEqual(keys(j1(w)), ["J1:alpha.label"]);
  w.cfg.tables.alpha.unmapped.label = "the prose label of the row; no word of it is matched";
  assert.deepEqual(j1(w).findings, [], "listed with a reason it passes");
});

test("INV-JOIN-1: in the schema job a text column the database has and the pin lacks is red the same PR, and a pinned column the database no longer has is red", () => {
  const w = world();
  const live = new Map([["alpha", { cols: new Set(["owner", "label", "unit", "note", "brand_new"]) }], ["beta", { cols: new Set(["body"]) }], ["gamma", { cols: new Set(["mode"]) }]]);
  assert.deepEqual(keys(j1(w, live)), ["J1:alpha.brand_new", "J1:beta.stage"]);
});

test("INV-JOIN-2: one fixture entity per failure is red naming its id and the rule; a clean fixture is clean; the walk is counted", () => {
  const clean = world();
  const r = j2(clean);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.walked, { classes: 4, entities: 4 });
  assert.equal(r.exempt.length, 3, "the lens is exempt on modes, relations and reach, and the exemption is counted");
  const cases = [
    ["empty modes", (w) => { w.couplings.entities[0].modes = []; }, "fuel:a", "modes"],
    ["a corridorOnly mode is not a leg mode", (w) => { w.couplings.entities[0].modes = ["multimodal"]; }, "fuel:a", "modes"],
    ["modeAgnostic with fewer than the five legs", (w) => { Object.assign(w.couplings.entities[0], { modeAgnostic: true, modes: ["road"] }); }, "fuel:a", "modes"],
    ["no relation", (w) => { w.couplings.entities.push(entity("fuel:lone", "fuel")); }, "fuel:lone", "relations"],
    ["related only to a same-surface entity", (w) => { w.couplings.entities.push(entity("fuel:c", "fuel")); w.couplings.relations = [rel("fuel:a", "fuel:c")]; }, "fuel:a", "reach"],
  ];
  for (const [name, plant, id, rule] of cases) {
    const w = world();
    plant(w);
    const found = j2(w).findings.filter((f) => f.key.startsWith(`J2:${id}:`));
    assert.ok(found.some((f) => f.key === `J2:${id}:${rule}` && f.msg.includes(id) && f.msg.includes(`${rule} failed`)), `${name}: ${keys(j2(w)).join(",")}`);
  }
});

test("INV-JOIN-2: a corridor-like class naming two modes but linked to one fails modeLinks naming the missing mode; a modeAgnostic entity with all five consignment_wide relations passes; a class with no entry is red", () => {
  const w = world();
  w.cfg.modeLinks.fuel = { relation: "corridor_links" };
  Object.assign(w.couplings.entities[0], { modes: ["road", "air"] });
  w.couplings.entities.push(entity("mode:air", "mode", { modes: ["air"] }));
  w.couplings.relations = [rel("fuel:a", "mode:road", "corridor_links"), rel("fuel:a", "site:b"), rel("site:b", "mode:road", "serves_hub"), rel("site:b", "mode:air", "serves_hub")];
  const bad = j2(w).findings.filter((f) => f.key === "J2:fuel:a:modeLinks");
  assert.equal(bad.length, 1);
  assert.match(bad[0].msg, /no corridor_links relation to mode:air/);
  const agnostic = world();
  Object.assign(agnostic.couplings.entities[0], { modeAgnostic: true, modes: LEGS });
  agnostic.couplings.entities.push(...LEGS.filter((m) => m !== "road").map((m) => entity(`mode:${m}`, "mode", { modes: [m] })));
  agnostic.couplings.relations = [rel("fuel:a", "site:b"), ...LEGS.map((m) => rel("site:b", `mode:${m}`, "serves_hub")), ...LEGS.map((m) => rel("fuel:a", `mode:${m}`, "consignment_wide"))];
  assert.deepEqual(j2(agnostic).findings, []);
  agnostic.couplings.relations = agnostic.couplings.relations.filter((r) => !(r.relation === "consignment_wide" && r.child === "mode:rail"));
  assert.deepEqual(keys(j2(agnostic)), ["J2:fuel:a:modeLinks"]);
  const noClass = world();
  noClass.couplings.classes.stray = {};
  noClass.couplings.entities.push(entity("stray:z", "stray"));
  assert.deepEqual(keys(j2(noClass)), ["J2:class:stray"]);
});

/** A sample of one unit column: `n` values of which `bad` are unnormalised. */
const unitSample = (n, bad) => ({ units: { "alpha.unit": { values: [...Array(n - bad).fill("EUR/t"), ...Array(bad).fill("furlongs per fortnight")], empty: 0, valued: n } } });
const withUnits = (extra = {}) => { const w = world(); w.cfg.unitColumns = [{ table: "alpha", column: "unit", kind: "text", valueColumn: "qty", ...extra }]; return w; };

test("INV-JOIN-3: a sample of 100 units with 6 unnormalised is red and prints the forms; 5 passes; a quantity with no unit above the threshold is red; a per-column threshold may only be lower", () => {
  assert.equal(unitStats(unitSample(100, 6).units["alpha.unit"].values).share, 0.06);
  const red = j3Findings(withUnits(), unitSample(100, 6), {});
  assert.deepEqual(keys(red), ["J3unit:alpha.unit"]);
  assert.match(red.findings[0].msg, /"furlongs per fortnight" x6/);
  assert.ok(red.report.some((l) => /unit alpha\.unit: sampled 100, empty 0, normalised 94/.test(l)));
  assert.deepEqual(j3Findings(withUnits(), unitSample(100, 5), {}).findings, []);
  assert.deepEqual(keys(j3Findings(withUnits({ threshold: 0.01 }), unitSample(100, 5), {})), ["J3unit:alpha.unit"], "a lower per-column threshold bites");
  assert.deepEqual(j3Findings(withUnits({ threshold: 0.5 }), unitSample(100, 6), {}).findings.map((f) => f.key), ["J3unit:alpha.unit"], "a higher one is ignored");
  const noUnit = unitSample(100, 0);
  noUnit.units["alpha.unit"].empty = 7;
  assert.deepEqual(keys(j3Findings(withUnits(), noUnit, {})), ["J3unitempty:alpha.unit"]);
});

test("INV-JOIN-3: a constant unit statutoryUnit does not know is red with the unit; a known one passes; no database is needed", () => {
  const w = world();
  w.cfg.unitColumns = [{ table: "alpha", column: "qty", kind: "constant", unit: "MW" }, { table: "alpha", column: "other", kind: "constant", unit: "cubits" }];
  const r = j3Findings(w, null, {});
  assert.deepEqual(keys(r), ["J3const:alpha.other"]);
  assert.match(r.findings[0].msg, /"cubits"/);
  assert.deepEqual([...r.ran].sort(), ["J3const", "J3sevw"]);
});

test("INV-JOIN-3: a token column with a value outside its vocabulary is red with the forms (an alias the CHECK refuses counts); a column with no vocabulary is red with its distinct values; a coupling map supplies the vocabulary", () => {
  const w = world();
  w.cfg.tokenColumns = [{ table: "gamma", column: "mode", array: false, vocabulary: "transport_mode" }, { table: "beta", column: "stage", array: false, vocabulary: null }, { table: "alpha", column: "owner", array: false, couplingMap: { table: "alpha", column: "owner" } }];
  w.couplings.columns[0].maps.push({ column: "owner", by: "map", map: { megawatt: "fuel:a", battery: "fuel:a" } });
  const dist = (values) => ({ values, nulls: 0, total: 0 });
  const sample = { tokens: { "gamma.mode": dist({ road: 90, sea: 10 }), "beta.stage": dist({ announced: 3, pilot: 2 }), "alpha.owner": dist({ megawatt: 5, hydrogen: 1 }) } };
  const r = j3Findings(w, sample, {});
  assert.deepEqual(keys(r), ["J3tok:alpha.owner", "J3tok:gamma.mode", "J3toknovocab:beta.stage"]);
  assert.match(r.findings.find((f) => f.key === "J3tok:gamma.mode").msg, /"sea" x10/);
  assert.ok(r.ran.has("J3toknovocab"), "the no-vocabulary findings are ratcheted: their entries are checked for staleness like any other");
  assert.match(r.findings.find((f) => f.key === "J3toknovocab:beta.stage").msg, /"announced", "pilot"/);
  sample.tokens["gamma.mode"] = dist({ road: 100 });
  sample.tokens["alpha.owner"] = dist({ megawatt: 5 });
  assert.deepEqual(keys(j3Findings(w, sample, {})), ["J3toknovocab:beta.stage"]);
  assert.deepEqual(codesOf(w, { vocabulary: "transport_mode" }), LEGS);
});

test("the no-credential run prints the skip line and the J1, J2 and J3(ii) result stands; --sample with no credential exits per skipVerdict: 1 on a workstation, a push and a dispatch, 2 only for a fork pull request", () => {
  const dir = mkdtempSync(join(tmpdir(), "caros-joinability-"));
  const payload = join(dir, "fork.json");
  writeFileSync(payload, JSON.stringify({ pull_request: { head: { repo: { fork: true } } } }));
  const run = (args, env) => spawnSync(process.execPath, ["--import", "./tests/_support/register.mjs", "scripts/ci/joinability.mjs", ...args], { env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env }, encoding: "utf8" });
  const bare = run([], {});
  assert.equal(bare.status, 0, bare.stdout + bare.stderr);
  assert.match(bare.stdout, /J3 sample skipped: SUPABASE_DB_URL not set/);
  assert.match(bare.stdout, /parts run: J1, J2, J3const, J3sevw/);
  for (const [name, env, status] of [["workstation", {}, 1], ["push", { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" }, 1], ["dispatch", { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch" }, 1], ["fork pull request", { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: payload }, 2]]) {
    const r = run(["--sample"], env);
    assert.equal(r.status, status, `${name}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /SUPABASE_DB_URL/, name);
    assert.doesNotMatch(r.stderr, /postgresql:/, "the message names the environment name, never a value");
  }
});

/** A src tree with one file, for the severity writer scan. */
function srcTree(file, text) {
  const dir = mkdtempSync(join(tmpdir(), "caros-severity-"));
  mkdirSync(dirname(join(dir, "src", file)), { recursive: true });
  writeFileSync(join(dir, "src", file), text);
  mkdirSync(join(dir, "src/core/brief/data"), { recursive: true });
  return dir;
}
const FIVE = ["action_required", "cost_alert", "window_closing", "competitive_edge", "monitoring"];

test("INV-JOIN-5: a writer that stores a severity outside the five tokens, or one that does not pass through toDbSeverity, is refused by the gate; the gated and the vocabulary-token writers pass", () => {
  const scan = (text) => severityWriters(srcTree("features/x/write.ts", text), FIVE).violations.map((v) => v.msg);
  assert.match(scan('await db.from("intelligence_items").insert({ title: "t", severity: "urgent" });')[0], /"urgent", which is not one of the five tokens/);
  assert.match(scan('await db.from("intelligence_items").update({ severity: raw.severity }).eq("id", 1);')[0], /does not pass through toDbSeverity/);
  assert.match(scan('const patch = { severity: sev };\nawait db.from("intelligence_items").update(patch).eq("id", 1);')[0], /does not pass through toDbSeverity/);
  assert.deepEqual(scan('await db.from("intelligence_items").insert({ severity: "monitoring" });'), []);
  assert.deepEqual(scan('await db.from("intelligence_items").update({ severity: toDbSeverity(md.severity) });'), []);
  assert.deepEqual(scan('let sev = null;\nsev = toDbSeverity(md.severity);\nconst patch = { severity: sev };\nawait db.from("intelligence_items").update(patch).eq("id", 1);'), []);
  assert.deepEqual(scan('await db.from("other_table").insert({ severity: "critical" });'), [], "only a write to intelligence_items is a severity writer path");
});

test("INV-JOIN-5: the set the writer gate accepts must be the five tokens: an extra value is red naming it; a stored severity outside the vocabulary or null on a brief-grade item is counted and red over the threshold", () => {
  const w = world();
  w.cfg.tokenColumns = [{ table: "items", column: "severity", array: false, severity: true, vocabulary: { file: "tokens.json", list: "severity", field: "db" } }];
  const dir = mkdtempSync(join(tmpdir(), "caros-vocab-"));
  writeFileSync(join(dir, "tokens.json"), JSON.stringify({ severity: FIVE.map((db) => ({ db })) }));
  w.root = dir;
  const writers = { accepted: [...FIVE, "critical", "watch"], violations: [{ file: "src/a.ts", line: 3, msg: "stores severity \"x\", which is not one of the five tokens" }] };
  const r = j3Findings(w, { tokens: { "items.severity": { values: { monitoring: 55, reference: 6, cost_alert: 30 }, nulls: 8, total: 99 } } }, writers);
  assert.deepEqual(keys(r), ["J3sev:items.severity", "J3sevw:accepts", "J3sevw:src/a.ts:3"]);
  assert.match(r.findings.find((f) => f.key === "J3sevw:accepts").msg, /critical, watch/);
  assert.match(r.findings.find((f) => f.key === "J3sev:items.severity").msg, /14 of 99 values .*6 outside, 8 null/);
  assert.deepEqual(keys(j3Findings(w, { tokens: { "items.severity": { values: { monitoring: 99 }, nulls: 0, total: 99 } } }, { accepted: FIVE, violations: [] })), []);
});

/** The counts of a table's rows the way the SQL computes them: rows, nulls per key column, rows with no entity. */
const countKeys = (rows, cols) => ({ rows: rows.length, unreferenced: rows.filter((r) => !r.filed).length, nulls: Object.fromEntries(cols.map((c) => [c, rows.filter((r) => r[c] === null || r[c] === undefined).length])) });

test("INV-JOIN-6: a planted row with a null detector-key column is reported unreachable with its table and column, on every fact table, and a stated absence covers exactly the rows the rows file says", () => {
  const w = world();
  for (const [table, spec] of Object.entries(w.facts)) {
    const cols = [spec.due, spec.qty?.column, spec.source].filter(Boolean);
    for (const col of cols) {
      const rows = [{ id: 1, filed: true, ...Object.fromEntries(cols.map((c) => [c, 1])) }, { id: 2, filed: true, ...Object.fromEntries(cols.map((c) => [c, c === col ? null : 1])) }];
      const r = keyFindings(w, { tables: { [table]: countKeys(rows, cols) } });
      assert.deepEqual(r.findings.map((f) => f.key), [`J5:${table}.${col}`], `${table}.${col}`);
      assert.match(r.findings[0].msg, new RegExp(`${table}\\.${col}: unreachable on 1 of 2 rows`));
      assert.ok(r.lines.some((l) => l.includes(`keys ${table}.${col}: 1 of 2 rows unreachable`)));
    }
  }
  // a stated absence per row: the rows file marks two rows absent, so two nulls are covered and a third is red
  const dir = mkdtempSync(join(tmpdir(), "caros-absent-"));
  writeFileSync(join(dir, "rows.json"), JSON.stringify({ rows: [{ absent: { due: "the capture states no date" } }, { absent: { due: "the capture states no date" } }, { due: 2027 }] }));
  const abs = world({ root: dir });
  abs.cfg.absences = [{ table: "alpha", column: "due", rowsFile: "rows.json", reason: "the capture states no date for the row" }];
  const nulls = (n) => ({ tables: { alpha: { rows: 3, unreferenced: 0, nulls: { due: n } } } });
  assert.deepEqual(keyFindings(abs, nulls(2)).findings, []);
  assert.deepEqual(keyFindings(abs, nulls(3)).findings.map((f) => f.key), ["J5:alpha.due"]);
  assert.deepEqual(keyFindings(abs, nulls(0)).findings.map((f) => f.key), ["J5stale:alpha.due"], "a stated absence with no null left is deleted");
  // an absence marked by the producer (statedBy): the nulls that carry no marker are red
  abs.cfg.absences = [{ table: "alpha", column: "due", statedBy: { obs_status: "L" }, reason: "the publisher gives no date; obs_status L is stored" }];
  assert.deepEqual(keyFindings(abs, { tables: nulls(3).tables, unstated: { "alpha.due": 0 } }).findings, []);
  assert.deepEqual(keyFindings(abs, { tables: nulls(3).tables, unstated: { "alpha.due": 1 } }).findings.map((f) => f.key), ["J5:alpha.due"]);
});

test("the allow-list ratchet: a new offender, a regressed share and an entry that no longer offends are red; a part that did not run leaves its entries alone", () => {
  const f = [{ key: "J1:a.b", msg: "m" }, { key: "J3unit:t.c", msg: "m", share: 0.2 }];
  const allow = { entries: [{ key: "J1:a.b" }, { key: "J3unit:t.c", share: 0.2 }] };
  assert.deepEqual(ratchet(f, allow, new Set(["J1", "J3unit"])), []);
  assert.match(ratchet([...f, { key: "J1:a.new", msg: "m" }], allow, new Set(["J1", "J3unit"]))[0], /^NEW J1:a\.new/);
  assert.match(ratchet([f[0], { ...f[1], share: 0.3 }], allow, new Set(["J1", "J3unit"]))[0], /^REGRESSED J3unit:t\.c/);
  assert.match(ratchet([f[1]], allow, new Set(["J1", "J3unit"]))[0], /^STALE J1:a\.b/);
  assert.deepEqual(ratchet([f[0]], allow, new Set(["J1"])), [], "the sample did not run, so its entry is not stale");
  assert.match(ratchet([{ key: "J5stale:x.y", msg: "m", hard: true }], { entries: [{ key: "J5stale:x.y" }] }, new Set(["J5stale"]))[0], /^HARD/);
});

test("the real data files: every finding of the gate is on the allow-list and no allow entry is stale (the credential-free parts)", () => {
  const r = spawnSync(process.execPath, ["--import", "./tests/_support/register.mjs", "scripts/ci/joinability.mjs"], { env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /joinability: clean/);
  assert.equal(typeof evaluate, "function");
});
