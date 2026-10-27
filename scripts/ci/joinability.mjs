// The joinability gate (JOIN-1, L8c): a stored row is not a reachable row. Three conditions make it reachable, and this checks all of them over the data files the engine reads:
//   J1 COLUMN COVERAGE  every text column of a table the engine joins (the keys of facts.json united with the tables of couplings.json columns[], never a typed list) is mapped (couplings.json maps: entity, mode, map, refs; an `alias` map matches words and is not honoured by the mining pass)
//      or listed unmapped with a reason that names what it is; a mapped-and-listed column, a stale map and a stale pin are red. `--schema` re-reads information_schema on the CI database: a new text column the pin lacks is red.
//   J2 ENTITY REACH     every coupling entity has modes, a relation and a path of relations to a class on another surface, by the rules its class declares in joinability.json `classes` (an exemption carries a reason and is counted);
//      `modeLinks` names the relation that binds an entity to each of its modes.
//   J3 NORMALISATION    (ii) the constant units the data declares pass statutoryUnit; (i) the text unit columns and (iii) the token columns of production (and intelligence_items.severity) normalise within `unnormalisedShare`,
//      read-only (BEGIN READ ONLY) when SUPABASE_DB_URL is set or `--sample` names it (scripts/ci/joinability/sample.mjs); the severity writer paths (src) are held to the same five tokens.
//   KEYS                the detector-input columns of every fact table (derived from facts.json) and the entity each row is filed under: a null is reported unreachable with table and column, unless a stated absence covers it.
// Findings are ratcheted by scripts/ci/joinability-allow.json (`--write-allow`): a new offender and an entry that no longer offends are both red, so the list only shrinks. Run through tests/_support/register.mjs ("@/" resolves).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { skipVerdict } from "@/core/harness/exit";

import { isMain } from "../lib/fs.mjs";

import { j3Findings, readSample, severityWriters } from "./joinability/sample.mjs";
import { psql } from "./psql.mjs";

export const DATA = "scripts/ci/data/joinability.json";
export const ALLOW = "scripts/ci/joinability-allow.json";
const MAPPED = new Set(["entity", "mode", "map", "refs"]);
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/** The data files the gate reads. Tests pass their own world with the same shape. */
export function loadWorld(root = ".") {
  const at = (p) => `${root}/${p}`;
  const schema = json(at("tests/_support/schema.json")).tables;
  const vocab = json(at("src/core/contracts/data/vocabularies.json"));
  return {
    root, couplings: json(at("src/core/coupling/data/couplings.json")), facts: json(at("src/core/flywheel/patterns/data/facts.json")), cfg: json(at(DATA)), vocab,
    schema: new Map(Object.entries(schema).map(([t, v]) => [t, new Set(v.columns)])), uuids: new Map(Object.entries(schema).map(([t, v]) => [t, new Set(v.uuid)])),
    legModes: new Set(Object.values(vocab.vocabularies.transport_mode).filter((m) => !m.corridorOnly).map((m) => m.code)), exists: (p) => existsSync(at(p)),
  };
}

/** The tables the engine joins: derived, so a table a later slice adds to facts.json or couplings.json is checked with no edit here. */
export const tablesOf = (w) => [...new Set([...Object.keys(w.facts), ...w.couplings.columns.map((c) => c.table), ...(w.cfg.extraTables ?? [])])];
const finding = (key, owner, msg, extra = {}) => ({ key, owner, msg, ...extra });

/** A reason names what the column is: not empty, not "n/a"; a reason that says a pass mines it names a module that exists. */
function reasonProblem(reason, w) {
  if (typeof reason !== "string" || reason.trim().length < 12 || /^\s*(n\/?a|none|tbd|todo)\b/i.test(reason)) return "its reason is empty or 'n/a'";
  const modules = reason.match(/\b(?:src|scripts)\/[\w./-]+\.(?:ts|mjs)\b/g) ?? [];
  if (/\b(mined|mines|mining|a pass)\b/i.test(reason) && !modules.length) return "its reason says a pass mines it and names no module";
  const missing = modules.find((m) => !w.exists(m));
  return missing ? `its reason names ${missing}, which does not exist` : null;
}

/** J1. `live`: Map table -> Set of the text columns information_schema holds now (the schema job), or null. */
export function j1(w, live = null) {
  const out = [];
  let columns = 0;
  const tables = tablesOf(w);
  for (const t of tables) {
    const pin = w.cfg.tables?.[t];
    const bad = (c, msg) => out.push(finding(`J1:${t}.${c}`, "couplings.json maps or the table's unmapped reasons", `${t}.${c}: ${msg}`));
    if (!pin) { out.push(finding(`J1:${t}`, "joinability.json tables", `${t}: no pin (the table's text columns are not listed; --pin writes it)`)); continue; }
    const cols = w.schema.get(t);
    if (!cols) { out.push(finding(`J1:${t}`, "tests/_support/schema.json", `${t}: absent from tests/_support/schema.json`)); continue; }
    const maps = w.couplings.columns.find((c) => c.table === t)?.maps ?? [];
    const mapped = new Set(maps.filter((m) => m.column && MAPPED.has(m.by)).map((m) => m.column));
    for (const m of maps) if (m.column && !cols.has(m.column)) bad(m.column, "a stale map: the column is not in the schema");
    for (const c of pin.textColumns) {
      columns += 1;
      const listed = pin.unmapped?.[c] !== undefined;
      if (!cols.has(c)) bad(c, "a stale pin: the column is not in the schema");
      else if (mapped.has(c) && listed) bad(c, "mapped in couplings.json and listed unmapped (a contradiction)");
      else if (!mapped.has(c) && !listed) bad(c, "a text column the engine can join on, neither mapped nor listed unmapped with a reason");
      else if (listed && reasonProblem(pin.unmapped[c], w)) bad(c, reasonProblem(pin.unmapped[c], w));
    }
    for (const c of Object.keys(pin.unmapped ?? {})) if (!pin.textColumns.includes(c)) bad(c, "listed unmapped but not a pinned text column");
    const now = live?.get(t)?.cols;
    if (now) {
      for (const c of now) if (!pin.textColumns.includes(c)) bad(c, "a text column exists in the database that the pin does not list");
      for (const c of pin.textColumns) if (!now.has(c)) bad(c, "a pinned column the database no longer has");
    }
  }
  return { findings: out, walked: { tables: tables.length, columns } };
}

/** J2. Entities against the rules their class declares in joinability.json `classes`, and the relation that binds each mode. */
export function j2(w) {
  // the vocabulary is the database now (NO-ENTITY-LISTS-1): couplings.json holds no entity or relation, so there is nothing static to walk; the reach of the live graph is measured over the database by the engine proof
  const { entities = [], relations = [] } = w.couplings;
  const near = new Map(entities.map((e) => [e.key, new Set()]));
  const linked = new Set(relations.map((r) => `${r.parent}|${r.relation}|${r.child}`));
  for (const r of relations) { near.get(r.parent)?.add(r.child); near.get(r.child)?.add(r.parent); }
  const classOf = new Map(entities.map((e) => [e.key, e.class]));
  const surfaces = (c) => new Set(w.cfg.classes?.[c]?.surfaces ?? []);
  const out = [];
  const exempt = [];
  const noEntry = new Set();
  for (const e of entities) {
    const cls = w.cfg.classes?.[e.class];
    const bad = (rule, msg) => out.push(finding(`J2:${e.key}:${rule}`, "couplings.json entities and relations", `${e.key} (${e.class}): ${rule} failed: ${msg}`));
    if (!cls) { if (!noEntry.has(e.class)) out.push(finding(`J2:class:${e.class}`, "joinability.json classes", `class ${e.class}: no entry in joinability.json classes (a new class is a decision, made in data)`)); noEntry.add(e.class); continue; }
    for (const rule of ["modes", "relations", "reach"]) {
      if (cls[rule] === "exempt") { if (!cls.reason) bad(rule, "exempt with no reason"); else exempt.push(`${e.key}:${rule}`); }
    }
    const modes = e.modes ?? [];
    if (cls.modes === "required") {
      if (e.modeAgnostic ? !same(new Set(modes), w.legModes) : !modes.length || modes.some((m) => !w.legModes.has(m))) bad("modes", e.modeAgnostic ? "modeAgnostic with modes not equal to the full leg set" : `no leg mode (modes: ${modes.join(",") || "none"})`);
    }
    if (cls.relations === "required" && !near.get(e.key)?.size) bad("relations", "in no relation as parent or child");
    if (cls.reach === "required") {
      const seen = new Set([e.key]);
      for (const k of seen) for (const n of near.get(k) ?? []) seen.add(n);
      const own = surfaces(e.class);
      if (![...seen].some((k) => { const s = surfaces(classOf.get(k)); return s.size && !same(s, own); })) bad("reach", "no path of relations to an entity on a different surface");
    }
    const link = w.cfg.modeLinks?.[e.class];
    if (link && (link.when !== "modeAgnostic" || e.modeAgnostic)) {
      const missing = modes.filter((m) => !linked.has(`${e.key}|${link.relation}|mode:${m}`));
      if (missing.length) bad("modeLinks", `no ${link.relation} relation to ${missing.map((m) => `mode:${m}`).join(", ")}`);
    }
  }
  return { findings: out, walked: { classes: Object.keys(w.couplings.classes).length, entities: entities.length }, exempt };
}

/** Findings against the allow-list: a new offender, a regression of a measured share, and an entry that no longer offends (only for the parts that ran) are red. */
export function ratchet(findings, allow, ran) {
  const held = new Map((allow.entries ?? []).map((e) => [e.key, e]));
  const red = [];
  for (const f of findings) {
    const a = held.get(f.key);
    if (f.hard) red.push(`HARD ${f.key}: ${f.msg}`);
    else if (!a) red.push(`NEW ${f.key}: ${f.msg}`);
    else if (f.share !== undefined && a.share !== undefined && f.share > a.share + 1e-4) red.push(`REGRESSED ${f.key}: share ${f.share.toFixed(4)} is above its entry ${a.share}`);
  }
  const keys = new Set(findings.map((f) => f.key));
  for (const a of held.values()) if (ran.has(a.key.split(":")[0]) && !keys.has(a.key)) red.push(`STALE ${a.key}: no longer an offender, delete the entry`);
  return red;
}

/** The text columns information_schema holds now for the tables, per table. */
export function liveTextColumns(run, tables) {
  const rows = run(`select table_name t, column_name c, data_type = 'ARRAY' arr from information_schema.columns where table_schema = 'public' and table_name = any(array[${tables.map((t) => `'${t}'`).join(",")}]) and (data_type in ('text', 'character varying') or (data_type = 'ARRAY' and udt_name in ('_text', '_varchar'))) order by 1, 2`);
  const live = new Map(tables.map((t) => [t, { cols: new Set(), arrays: new Set() }]));
  for (const r of rows) { live.get(r.t).cols.add(r.c); if (r.arr) live.get(r.t).arrays.add(r.c); }
  return live;
}

/** A read-only runner over a connection string: the statements (a string, or an array run in one connection) execute inside BEGIN READ ONLY; each statement's rows come back as objects, one result per statement. */
export function readOnly(url) {
  return (sql) => {
    const list = [sql].flat();
    const select = (x) => `select coalesce(jsonb_agg(q), '[]'::jsonb) from (${x}) q;`;
    const r = psql(url, { sql: ["BEGIN READ ONLY;", "SET LOCAL statement_timeout = '180s';", ...list.map(select), "ROLLBACK;"].join("\n"), tuples: true });
    if (r.status !== 0) throw new Error(`joinability: the read failed\n${r.stderr}`);
    const out = r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return Array.isArray(sql) ? out : out[0];
  };
}

/** Everything the gate decides, as findings plus the counts walked. `sample`: the production sample, or null. */
export function evaluate(w, { sample = null, live = null, writers = [] } = {}) {
  const a = j1(w, live);
  const b = j2(w);
  const c = j3Findings(w, sample, writers);
  return { findings: [...a.findings, ...b.findings, ...c.findings], walked: { ...a.walked, ...b.walked, ...c.walked }, exempt: b.exempt, ran: new Set(["J1", "J2", ...c.ran]), report: c.report };
}

function main() {
  const { values } = parseArgs({ options: { schema: { type: "boolean" }, sample: { type: "boolean" }, "write-allow": { type: "boolean" }, pin: { type: "boolean" }, report: { type: "string" } } });
  const w = loadWorld();
  const env = process.env;
  const url = env.SUPABASE_DB_URL;
  if (values.pin || values.schema) {
    const v = skipVerdict(env, env.DATABASE_URL || (values.pin && url) ? [] : ["DATABASE_URL"], true);
    if (v.message) { console.error(`joinability: ${v.message}`); process.exit(v.exit); }
  }
  if (values.pin) {
    const live = liveTextColumns(readOnly(env.DATABASE_URL ?? url), tablesOf(w));
    for (const [t, cols] of live) w.cfg.tables[t] = { ...w.cfg.tables[t], textColumns: [...cols.cols], arrayColumns: [...cols.arrays] };
    writeFileSync(DATA, `${JSON.stringify(w.cfg, null, 2)}\n`);
    console.log(`joinability: pinned ${[...live.values()].reduce((n, s) => n + s.cols.size, 0)} text columns over ${live.size} tables`);
    return;
  }
  const live = values.schema ? liveTextColumns(readOnly(env.DATABASE_URL), tablesOf(w)) : null;
  let sample = null;
  if (values.sample || url) {
    const v = skipVerdict(env, url ? [] : ["SUPABASE_DB_URL"], Boolean(values.sample));
    if (v.message) { console.error(`joinability: J3 sample ${v.message}`); if (v.exit !== 0 && values.sample) process.exit(v.exit); }
    if (url) sample = readSample(readOnly(url), w);
  } else console.log("J3 sample skipped: SUPABASE_DB_URL not set");
  const r = evaluate(w, { sample, live, writers: severityWriters(w.root) });
  const allow = existsSync(ALLOW) ? json(ALLOW) : { entries: [] };
  if (values["write-allow"]) {
    const date = new Date().toISOString().slice(0, 10);
    const old = new Map((allow.entries ?? []).map((e) => [e.key, e]));
    const kept = (allow.entries ?? []).filter((e) => !r.ran.has(e.key.split(":")[0]));
    const entries = [...kept, ...r.findings.filter((f) => !f.hard).map((f) => ({ key: f.key, owner: f.owner, date: old.get(f.key)?.date ?? date, reason: f.msg, ...(f.share !== undefined ? { share: Math.round(f.share * 1e4) / 1e4 } : {}) }))].sort((x, y) => x.key.localeCompare(y.key));
    writeFileSync(ALLOW, `${JSON.stringify({ _doc: "Known joinability findings (scripts/ci/joinability.mjs --write-allow). A new offender is a red run; an entry that no longer offends is a red run (delete it); a share above its entry is a regression. Each entry is owed a data-file batch or a slice (its owner).", entries }, null, 1)}\n`);
    console.log(`joinability: wrote ${entries.length} allow entries`);
    return;
  }
  const red = ratchet(r.findings, allow, r.ran);
  const w2 = r.walked;
  const lines = [`joinability: walked ${w2.tables} tables, ${w2.columns} pinned text columns, ${w2.classes} classes, ${w2.entities} entities; ${r.exempt.length} class exemptions; ${r.findings.length} findings, ${(allow.entries ?? []).length} allow entries; parts run: ${[...r.ran].join(", ")}`, ...r.report];
  for (const l of [...lines, ...red.map((x) => `RED ${x}`)]) console.log(l);
  if (values.report) writeFileSync(values.report, `${JSON.stringify({ walked: w2, findings: r.findings, report: r.report, exempt: r.exempt }, null, 1)}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Joinability\n\n${lines.map((l) => `- ${l}`).join("\n")}\n${red.length ? `\n${red.map((x) => `- RED ${x}`).join("\n")}\n` : ""}`);
  console.log(red.length ? `joinability: ${red.length} red` : "joinability: clean (every finding is on the allow-list)");
  process.exit(red.length ? 1 : 0);
}
if (isMain(import.meta.url)) main();
