// J3 and the key coverage of the joinability gate (scripts/ci/joinability.mjs). Everything here is pure over (the data files, a sample); `readSample` is the only code that touches a database, through the read-only runner it is handed.
//   (ii) constants  the unit the data states for a numeric column passes statutoryUnit, the one unit normaliser (src/core/parse/data/statutory-units.json); an unknown unit is red with the unit, never a typed bypass
//   (i)  text units a read-only sample (500 values per column, ORDER BY pk, non-empty) normalises through statutoryUnit within `unnormalisedShare`; a quantity with no unit is counted the same way
//   (iii) tokens    the distinct values of a token column are codes of its vocabulary (vocabularies.json, a coupling map's keys, or contract.json for severity); a column with no vocabulary is red with its values printed
//   (iv) patterns   the distinct values of a column that holds a shaped token (an ISO code, a readiness level, a corridor name) match the regex joinability.json `patterns` names for it; a value outside is red with the values printed
//   writers         every src path that stores intelligence_items.severity goes through toDbSeverity, and the set that gate accepts is the five tokens (ADR-052)
//   keys            the detector-input columns of each fact table (derived from facts.json) and the entity each row is filed under; a null is reported unreachable unless a stated absence covers it
import { readFileSync } from "node:fs";

import ts from "typescript";

import { DB_SEVERITY_VALUES } from "@/core/brief/vocab";
import { statutoryUnit } from "@/core/parse";
import { surfaceOf } from "@/core/routing";

import { walk } from "../../lib/fs.mjs";

const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const q = (id) => `"${String(id).replaceAll('"', '""')}"`;
const top = (counts, n = 10) => [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
const finding = (key, owner, msg, extra = {}) => ({ key, owner, msg, ...extra });
/** The `where` clause a token or pattern column states (column = 'value' pairs), or empty. */
const whereOf = (c) => (c.where ? ` where ${Object.entries(c.where).map(([k, v]) => `${q(k)} = '${String(v).replaceAll("'", "''")}'`).join(" and ")}` : "");
/** The distinct values of a column (an array column unnested) with their counts: the one read the token and pattern checks share. */
const distinctSql = (c) => `select v, count(*) n from (select ${c.array ? `unnest(${q(c.column)})` : q(c.column)}::text v from ${q(c.table)}${whereOf(c)}) s where v is not null group by v`;

/** The columns of a fact table a detector reads to place a row in time, quantity, tier or source (facts.json, never a typed list). */
export const keyColumns = (spec, entityColumns = []) => [...new Set([...[spec].flat().flatMap((x) => [x.at, ...[x.due ?? []].flat(), x.dueYear, x.dueMonthsAfterAt, x.qty?.column, x.qty?.unitColumn, x.qty?.figure, x.source, x.tier, x.trl, x.group, x.capture, x.resolved, x.from, x.until]), ...entityColumns].filter(Boolean))];

/** The columns of a table that hold an entity id: the `entity` maps of couplings.json and the table's own entityColumns entry. */
export const entityColumnsOf = (w, t) => [...new Set([...(w.couplings.columns.find((c) => c.table === t)?.maps ?? []).filter((m) => m.by === "entity" && m.column).map((m) => m.column), ...(w.cfg.entityColumns?.[t] ? [w.cfg.entityColumns[t]] : [])])];

/** The codes a token column's vocabulary holds, or null when it names none. */
export function codesOf(w, spec) {
  const v = spec.vocabulary;
  if (spec.couplingMap) return Object.keys(w.couplings.columns.find((c) => c.table === spec.couplingMap.table)?.maps.find((m) => m.column === spec.couplingMap.column && m.map)?.map ?? {});
  if (!v) return null;
  if (typeof v === "string") return Object.keys(w.vocab.vocabularies[v] ?? {});
  return json(`${w.root}/${v.file}`)[v.list].map((x) => x[v.field]);
}

/** Per column: how many sampled values the unit map reads, and the forms it does not. */
export function unitStats(values) {
  const bad = new Map();
  let normalised = 0;
  for (const v of values) {
    if (statutoryUnit(String(v))) normalised += 1;
    else bad.set(String(v), (bad.get(String(v)) ?? 0) + 1);
  }
  return { sampled: values.length, normalised, share: values.length ? (values.length - normalised) / values.length : 0, top: top(bad) };
}

/** The stated absences that cover a column, with how many nulls they cover (Infinity when the whole source states none). */
function absenceOf(w, table, column) {
  const a = (w.cfg.absences ?? []).find((x) => x.table === table && x.column === column);
  if (!a) return null;
  const rows = a.rowsFile ? json(`${w.root}/${a.rowsFile}`).rows : null;
  return { reason: a.reason, statedBy: a.statedBy, max: rows ? rows.filter((r) => typeof r.absent?.[column] === "string" && r.absent[column].trim()).length : Infinity };
}

/** Null detector keys and unfiled rows per table, as findings (a planted row with a null key is reported with its table and column). */
export function keyFindings(w, keys) {
  const out = [];
  const lines = [];
  for (const [t, k] of Object.entries(keys.tables ?? keys)) {
    lines.push(`keys ${t}: ${k.unreferenced} of ${k.rows} rows have no entity_refs row from the mining pass (entity_refs mined so far: ${keys.minedRefs ?? 0})`);
    for (const [c, n] of Object.entries(k.nulls)) {
      const a = absenceOf(w, t, c);
      const unstated = a?.statedBy ? keys.unstated?.[`${t}.${c}`] ?? n : 0;
      if (a && unstated > 0) out.push(finding(`J5:${t}.${c}`, "the producer of the table", `${t}.${c}: ${unstated} null rows do not carry the marker the stated absence names (${JSON.stringify(a.statedBy)})`, { share: unstated / (k.rows || 1) }));
      lines.push(`keys ${t}.${c}: ${n} of ${k.rows} rows unreachable${a ? `; stated absence (max ${a.max}): ${a.reason}` : ""}`);
      if (a && n < Math.min(a.max, k.rows) && n === 0) out.push(finding(`J5stale:${t}.${c}`, "joinability.json absences", `${t}.${c}: a stated absence with no null left; delete it`, { hard: true }));
      else if (n > 0 && (!a || n > a.max) && !(a && a.statedBy)) out.push(finding(`J5:${t}.${c}`, "the producer of the table", `${t}.${c}: unreachable on ${n} of ${k.rows} rows${a ? ` (${a.max} stated)` : ""}: null`, { share: n / (k.rows || 1) }));
    }
  }
  return { findings: out, lines };
}

/** The findings of the three parts and the severity writers. `sample` null: only the credential-free parts (constants, writers) run. */
export function j3Findings(w, sample, writers) {
  const t = w.cfg.unnormalisedShare ?? 0.05;
  const out = [];
  const report = [];
  const ran = new Set(["J3const", "J3sevw"]);
  let columns = 0;
  const limit = (spec) => Math.min(t, spec.threshold ?? t);
  for (const u of w.cfg.unitColumns ?? []) {
    columns += 1;
    const id = `${u.table}.${u.column}`;
    if (u.kind === "constant") {
      if (!statutoryUnit(u.unit)) out.push(finding(`J3const:${id}`, "statutory-units.json forms", `${id}: the declared unit "${u.unit}" is not a form statutoryUnit knows`));
      continue;
    }
    const s = sample?.units?.[id];
    if (!s) continue;
    ran.add("J3unit").add("J3unitempty");
    const st = unitStats(s.values);
    report.push(`unit ${id}: sampled ${st.sampled}, empty ${s.empty}, normalised ${st.normalised}, unnormalised share ${st.share.toFixed(4)}; top: ${st.top.map(([f, n]) => `${JSON.stringify(f)} x${n}`).join(", ") || "none"}`);
    if (st.share > limit(u)) out.push(finding(`J3unit:${id}`, "statutory-units.json forms", `${id}: unnormalised share ${st.share.toFixed(4)} over ${limit(u)}; top forms ${st.top.map(([f, n]) => `${JSON.stringify(f)} x${n}`).join(", ")}`, { share: st.share }));
    const empty = s.valued ? s.empty / s.valued : 0;
    if (u.valueColumn && empty > limit(u)) out.push(finding(`J3unitempty:${id}`, "the producer of the table", `${id}: ${s.empty} of ${s.valued} rows carry ${u.valueColumn} and no unit`, { share: empty }));
  }
  const auto = (w.cfg.autoVocabularies ?? []).flatMap((v) => Object.entries(w.cfg.tables).flatMap(([tb, p]) => (p.textColumns.includes(v) && !(w.cfg.tokenColumns ?? []).some((x) => x.table === tb && x.column === v) ? [{ table: tb, column: v, array: p.arrayColumns?.includes(v) ?? false, vocabulary: v }] : [])));
  for (const c of [...(w.cfg.tokenColumns ?? []), ...auto]) {
    columns += 1;
    const id = `${c.table}.${c.column}`;
    const dist = sample?.tokens?.[id];
    if (!dist) continue;
    ran.add(c.severity ? "J3sev" : "J3tok").add(c.severity ? "J3sevnovocab" : "J3toknovocab");
    const codes = codesOf(w, c);
    const total = Object.values(dist.values).reduce((a, b) => a + b, 0);
    const outside = Object.entries(dist.values).filter(([v]) => !codes?.includes(v));
    const bad = outside.reduce((a, [, n]) => a + n, 0) + (c.severity ? dist.nulls : 0);
    const forms2 = top(outside).map(([v, n]) => `${JSON.stringify(v)} x${n}`).join(", ");
    report.push(`token ${id}: ${total} values, outside ${outside.reduce((a, [, n]) => a + n, 0)}${c.severity ? `, null ${dist.nulls} of ${dist.total} rows` : ""}; ${codes ? `forms ${forms2 || "none"}` : `NO VOCABULARY; distinct: ${top(Object.entries(dist.values), 40).map(([v, n]) => `${JSON.stringify(v)} x${n}`).join(", ")}`}`);
    if (!codes) out.push(finding(`${c.severity ? "J3sev" : "J3tok"}novocab:${id}`, "vocabularies.json", `${id}: no vocabulary; distinct values ${top(Object.entries(dist.values), 40).map(([v]) => JSON.stringify(v)).join(", ")}`));
    else if (bad / (c.severity ? dist.total : total || 1) > limit(c)) out.push(finding(`${c.severity ? "J3sev" : "J3tok"}:${id}`, c.severity ? "slice SEV-1 (migration 0137)" : "vocabularies.json or the writer", `${id}: ${bad} of ${c.severity ? dist.total : total} values are not codes of ${typeof c.vocabulary === "string" ? c.vocabulary : c.vocabulary?.file ?? "the coupling map"}${c.severity ? ` (${outside.reduce((a, [, n]) => a + n, 0)} outside, ${dist.nulls} null)` : ""}; forms ${forms2}`, { share: bad / (c.severity ? dist.total : total) }));
  }
  for (const c of w.cfg.patterns ?? []) {
    columns += 1;
    const id = `${c.table}.${c.column}`;
    const dist = sample?.patterns?.[id];
    if (!dist) continue;
    ran.add("J3pat");
    const re = new RegExp(c.regex);
    const outside = Object.entries(dist).filter(([v]) => !re.test(v));
    const n = outside.reduce((a, [, k]) => a + k, 0);
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    report.push(`pattern ${id}: ${total} values, outside ${n}; forms ${top(outside).map(([v, k]) => `${JSON.stringify(v)} x${k}`).join(", ") || "none"}`);
    if (n) out.push(finding(`J3pat:${id}`, "the producer of the table", `${id}: ${n} of ${total} values do not match ${c.regex} (${c.reason}); forms ${top(outside).map(([v, k]) => `${JSON.stringify(v)} x${k}`).join(", ")}`, { share: n / total }));
  }
  if (sample?.keys) {
    const k = keyFindings(w, sample.keys);
    ran.add("J5").add("J5stale");
    out.push(...k.findings);
    report.push(...k.lines);
  }
  if (sample?.obligations) {
    const o = sample.obligations;
    report.push(`obligations: ${o.rows} rows; mode stated on ${o.withMode}; no mode ${o.rows - o.withMode}; an instrument entity on ${o.withInstrument}; dated within 90 days ${o.due90} (no mode and no instrument entity: ${o.due90Neither}); dated at all ${o.dated}`);
  }
  for (const c of sample?.claims ?? []) report.push(`claims surface ${c.surface}, tier ${c.tier ?? "none"}: ${c.claims} claims (${c.recent} in the last 90 days) from ${c.sources} sources`);
  const sevCodes = codesOf(w, (w.cfg.tokenColumns ?? []).find((x) => x.severity) ?? {}) ?? [];
  const extras = (writers.accepted ?? []).filter((v) => !sevCodes.includes(v));
  if (extras.length) out.push(finding("J3sevw:accepts", "slice SEV-1 and the brief vocabulary (ADR-052 point 4)", `the severity writer gate (toDbSeverity, DB_SEVERITY_VALUES) accepts ${extras.length} values outside the five tokens: ${extras.join(", ")}`));
  for (const v of writers.violations ?? []) out.push(finding(`J3sevw:${v.file}:${v.line}`, "the writer's owner", `${v.file}:${v.line}: ${v.msg}`));
  return { findings: out, walked: { unitAndTokenColumns: columns }, ran, report };
}

/** The `.from("intelligence_items")` write calls of a file and the object literal each stores: the argument itself, or the same-file `const` it names. */
function writePayloads(sf) {
  const decls = new Map();
  const find = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) decls.set(n.name.text, n.initializer);
    ts.forEachChild(n, find);
  };
  find(sf);
  const out = [];
  const onTable = (e) => (ts.isCallExpression(e) ? (ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "from" ? ts.isStringLiteralLike(e.arguments[0] ?? e) && e.arguments[0].text === "intelligence_items" : onTable(e.expression)) : ts.isPropertyAccessExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e) ? onTable(e.expression) : false);
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ["insert", "update", "upsert"].includes(n.expression.name.text) && onTable(n.expression.expression)) {
      let a = n.arguments[0];
      if (a && ts.isIdentifier(a)) a = decls.get(a.text);
      while (a && (ts.isAsExpression(a) || ts.isParenthesizedExpression(a))) a = a.expression;
      if (a && ts.isObjectLiteralExpression(a)) out.push(a);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The names a file assigns from a toDbSeverity call (`sev = toDbSeverity(x)`, `const sev = toDbSeverity(x)`). */
function fromGate(sf) {
  const names = new Set();
  const visit = (n) => {
    const call = ts.isVariableDeclaration(n) ? n.initializer : ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken ? n.right : null;
    const name = ts.isVariableDeclaration(n) ? n.name : ts.isBinaryExpression(n) ? n.left : null;
    if (call && name && ts.isIdentifier(name) && ts.isCallExpression(call) && call.expression.getText(sf) === "toDbSeverity") names.add(name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

/** The severity writer paths: every object stored in intelligence_items that sets `severity` sets a vocabulary token, a toDbSeverity call, or a name assigned from one; and the values that gate accepts. */
export function severityWriters(root = ".", tokens = null) {
  const sevCodes = tokens ?? json(`${root}/src/core/brief/data/contract.json`).severity.map((s) => s.db);
  const violations = [];
  for (const file of walk(`${root}/src`, (n) => /.(ts|tsx)$/.test(n))) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("intelligence_items")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const assigned = fromGate(sf);
    for (const obj of writePayloads(sf)) {
      for (const p of obj.properties) {
        if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) || p.name.getText(sf) !== "severity") continue;
        const v = ts.isPropertyAssignment(p) ? p.initializer : p.name;
        const gated = ts.isCallExpression(v) && v.expression.getText(sf) === "toDbSeverity";
        const named = ts.isIdentifier(v) && assigned.has(v.text);
        const msg = ts.isStringLiteralLike(v) ? (sevCodes.includes(v.text) ? null : `stores severity "${v.text}", which is not one of the five tokens`) : gated || named ? null : "stores a severity that does not pass through toDbSeverity";
        if (msg) violations.push({ file: file.replace(`${root}/`, ""), line: sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1, msg });
      }
    }
  }
  return { violations, accepted: [...DB_SEVERITY_VALUES] };
}

/** The text of a uuid-or-key: a uuid as it is, any other key as the uuid of its sha256 (uuidOf in src/core/coupling/refs.ts), so one expression serves a uuid pk and a text pk. */
const refOf = (col) => {
  const h = `encode(sha256(convert_to(${col}::text, 'UTF8')), 'hex')`;
  return `(case when ${col}::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then ${col}::text else substr(${h}, 1, 8) || '-' || substr(${h}, 9, 4) || '-' || substr(${h}, 13, 4) || '-' || substr(${h}, 17, 4) || '-' || substr(${h}, 21, 12) end)`;
};

/** P4 reads an obligation's mode and its instrument entity (both typed columns; the flywheel matches no words of the text): how many state a mode, carry an instrument entity, and fall due within 90 days with neither. */
export function obligationCoverage(rows) {
  const horizon = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const out = { rows: rows.length, withMode: 0, withInstrument: 0, dated: 0, due90: 0, due90Neither: 0 };
  for (const r of rows) {
    const mode = Number(r.nm) > 0;
    const term = r.has_instrument === true || r.has_instrument === "true" || r.has_instrument === "t";
    out.withMode += mode ? 1 : 0;
    out.withInstrument += term ? 1 : 0;
    out.dated += r.first_deadline ? 1 : 0;
    if (r.first_deadline && String(r.first_deadline) >= today && String(r.first_deadline) <= horizon) {
      out.due90 += 1;
      out.due90Neither += mode || term ? 0 : 1;
    }
  }
  return out;
}

/** The production sample: the read-only statements the data files call for, run in ONE batch through `run` (array of sql -> array of row arrays). No row is written. */
export function readSample(run, w) {
  const jobs = [];
  const add = (sql, then) => jobs.push({ sql, then });
  const s = { units: {}, tokens: {}, keys: { tables: {}, minedRefs: 0 }, claims: [] };
  const pkOf = (t) => w.couplings.columns.find((c) => c.table === t)?.pk ?? [w.facts[t]].flat()[0]?.pk;
  for (const u of (w.cfg.unitColumns ?? []).filter((x) => x.kind === "text")) {
    const col = q(u.column);
    const val = u.valueColumn ? q(u.valueColumn) : col;
    const have = {};
    add(`select count(*) filter (where ${u.valueColumn ? `${val} is not null and (${col} is null or ${col} = '')` : "false"}) empty, count(*) filter (where ${val} is not null) valued from ${q(u.table)}`, ([c]) => Object.assign(have, { empty: Number(c.empty), valued: Number(c.valued) }));
    add(`select ${col}::text v from ${q(u.table)} where ${col} is not null and ${col} <> '' order by ${q(pkOf(u.table))} limit 500`, (rows) => (s.units[`${u.table}.${u.column}`] = { values: rows.map((r) => r.v), ...have }));
  }
  const auto = (w.cfg.autoVocabularies ?? []).flatMap((v) => Object.entries(w.cfg.tables).flatMap(([tb, p]) => (p.textColumns.includes(v) ? [{ table: tb, column: v, array: p.arrayColumns?.includes(v) ?? false }] : [])));
  for (const c of [...(w.cfg.tokenColumns ?? []), ...auto]) {
    const where = whereOf(c);
    const cell = { values: {}, nulls: 0, total: 0 };
    s.tokens[`${c.table}.${c.column}`] = cell;
    add(distinctSql(c), (rows) => (cell.values = Object.fromEntries(rows.map((r) => [r.v, Number(r.n)]))));
    if (c.severity) add(`select count(*) total, count(*) filter (where ${q(c.column)} is null) nulls from ${q(c.table)}${where}`, ([t]) => Object.assign(cell, { total: Number(t.total), nulls: Number(t.nulls) }));
  }
  s.patterns = {};
  for (const c of w.cfg.patterns ?? []) add(distinctSql(c), (rows) => (s.patterns[`${c.table}.${c.column}`] = Object.fromEntries(rows.map((r) => [r.v, Number(r.n)]))));
  for (const [t, specs] of Object.entries(w.facts)) {
    const spec = [specs].flat()[0];
    const cols = keyColumns(specs, entityColumnsOf(w, t)).filter((c) => w.schema.get(t)?.has(c));
    const own = w.cfg.entityColumns?.[t];
    const unfiled = own ? `x.${q(own)} is null` : `${refOf(`x.${q(spec.pk)}`)} not in (select r.ref_id::text from entity_refs r where r.ref_table = '${spec.edge ?? t}' and r.method_version is not null)`;
    add(`select count(*) rows, count(*) filter (where ${unfiled}) unreferenced${cols.map((c, i) => `, count(*) filter (where x.${q(c)} is null) n${i}`).join("")} from ${q(t)} x`, ([r]) => (s.keys.tables[t] = { rows: Number(r.rows), unreferenced: Number(r.unreferenced), nulls: Object.fromEntries(cols.map((c, i) => [c, Number(r[`n${i}`])])) }));
  }
  for (const a of (w.cfg.absences ?? []).filter((x) => x.statedBy)) add(`select count(*) n from ${q(a.table)} where ${q(a.column)} is null and not coalesce((${Object.entries(a.statedBy).map(([k, v]) => `${q(k)} = '${String(v).replaceAll("'", "''")}'`).join(" and ")}), false)`, ([r]) => ((s.keys.unstated ??= {})[`${a.table}.${a.column}`] = Number(r.n)));
  add("select due_date first_deadline, coalesce(array_length(mode, 1), 0) nm, instrument_entity_id is not null has_instrument from obligation_objects", (rows) => (s.obligations = obligationCoverage(rows)));
  add("select count(*) n from entity_refs where method_version is not null", ([r]) => (s.keys.minedRefs = Number(r.n)));
  add("select i.item_type, i.domain, c.source_tier_at_grounding tier, count(*) claims, count(*) filter (where i.added_date >= current_date - 90) recent from section_claim_provenance c join intelligence_items i on i.id = c.intelligence_item_id group by 1, 2, 3", (rows) => (s.claimGroups = rows));
  run(jobs.map((j) => j.sql)).forEach((rows, i) => jobs[i].then(rows));
  // the claims of each surface and tier, and the distinct sources behind them (not additive across item types, so asked per surface)
  const bySurface = new Map();
  for (const g of s.claimGroups) {
    const surface = surfaceOf(g.item_type, g.domain === null ? null : Number(g.domain));
    bySurface.set(surface, [...(bySurface.get(surface) ?? []), g]);
  }
  const pairs = (gs) => gs.map((g) => `(i.item_type = '${g.item_type}' and i.domain ${g.domain === null ? "is null" : `= ${Number(g.domain)}`})`).join(" or ");
  const asked = [...bySurface].map(([surface, gs]) => ({ surface, gs }));
  const distinct = run(asked.map((a) => `select c.source_tier_at_grounding tier, count(distinct c.source_id) sources from section_claim_provenance c join intelligence_items i on i.id = c.intelligence_item_id where ${pairs(a.gs)} group by 1`));
  s.claims = asked.flatMap((a, n) => distinct[n].map((d) => ({ surface: a.surface, tier: d.tier, sources: Number(d.sources), claims: a.gs.filter((g) => g.tier === d.tier).reduce((x, g) => x + Number(g.claims), 0), recent: a.gs.filter((g) => g.tier === d.tier).reduce((x, g) => x + Number(g.recent), 0) })));
  delete s.claimGroups;
  return s;
}
