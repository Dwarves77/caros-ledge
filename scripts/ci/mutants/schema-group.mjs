// The schema class of the mutants job: the mutants whose gate needs a database. One PostgreSQL cluster serves them (the CI service container, DATABASE_URL, or an embedded one on a workstation); each group gets its own
// database in it, dropped after:
//   selfcheck:*   every migration's self-check attacked in ONE chain run (`schema-apply.mjs --selfcheck-mutants`), which prints a `MUTANT selfcheck:<id> <verdict> <line>` per migration;
//   property:*    one database built by `schema-apply.mjs --build-only` on the untouched tree, then each mutant edits the check on the scratch tree and runs it against that database;
//   schema:apply  the whole schema job on a database of its own, once per mutant (the mutant edits the job or what it builds from).
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

import { withEmbeddedPostgres } from "../embedded-pg.mjs";

import { applyMutant, execIn, gateCommand, judge } from "./run.mjs";
import { covered } from "./registry.mjs";
import { restore } from "./scratch.mjs";

const withUrlDb = (adminUrl, name) => {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
};

async function withDatabase(adminUrl, name, fn) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  try {
    return await fn(withUrlDb(adminUrl, name));
  } finally {
    const again = new pg.Client({ connectionString: adminUrl });
    await again.connect();
    await again.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await again.end();
  }
}

const rowOf = (m, extra) => ({ id: m.id, gate: m.gate, class: "schema", closes: m.closes, ...extra });

/** The MUTANT lines of a `--selfcheck-mutants` run as a Map gate -> { verdict, line }. */
export function parseMutantLines(output) {
  return new Map([...output.matchAll(/^MUTANT (selfcheck:\S+) (red|green|error) (.*)$/gm)].map((m) => [m[1], { verdict: m[2], line: m[3] }]));
}

async function selfChecks({ dir, mutants, inventory, adminUrl, log }) {
  const rules = mutants.map((m) => ({ gate: m.gate, transform: m.apply.transform }));
  const spec = join(dir, ".selfcheck-mutants.json");
  restore(dir);
  writeFileSync(spec, JSON.stringify(rules));
  log("schema mutants: every migration's self-check, one chain run");
  const started = Date.now();
  const r = await withDatabase(adminUrl, "mut_selfcheck", (url) => execIn(dir, process.execPath, ["scripts/ci/schema-apply.mjs", "--selfcheck-mutants", spec], { DATABASE_URL: url }, 30 * 60 * 1000));
  const seen = parseMutantLines(r.output);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  return mutants.flatMap((m) =>
    covered(m.gate, inventory).map((gate) => {
      const hit = seen.get(gate);
      // An exact entry owns its gate; a wildcard entry covers the gates no exact entry names.
      if (m.gate.endsWith(":*") && mutants.some((x) => x.gate === gate)) return null;
      return rowOf(m, { id: `${m.id}/${gate.slice("selfcheck:".length)}`, gate, ...(hit ?? { verdict: "error", line: `the chain run printed no verdict for ${gate} (${judge("schema:apply", r).line})` }), seconds });
    }).filter(Boolean),
  );
}

async function properties({ dir, mutants, adminUrl, log }) {
  restore(dir);
  return withDatabase(adminUrl, "mut_properties", async (url) => {
    log("schema mutants: building the database the property mutants run against");
    const built = execIn(dir, process.execPath, ["scripts/ci/schema-apply.mjs", "--build-only"], { DATABASE_URL: url }, 30 * 60 * 1000);
    if (built.code !== 0) throw new Error(`the property database did not build: ${judge("schema:apply", built).line}`);
    const rows = [];
    for (const m of mutants) {
      restore(dir);
      try {
        applyMutant(dir, m);
      } catch (e) {
        rows.push(rowOf(m, { verdict: "error", line: `the mutant did not apply: ${e.message}`, seconds: 0 }));
        continue;
      }
      const { command, args, env } = gateCommand(m.gate);
      const r = execIn(dir, command, args, { ...env, DATABASE_URL: url });
      rows.push(rowOf(m, { ...judge(m.gate, r), exit: r.code, seconds: Math.round(r.ms / 100) / 10 }));
      restore(dir);
    }
    return rows;
  });
}

async function wholeJob({ dir, mutants, adminUrl, log }) {
  const rows = [];
  for (const [i, m] of mutants.entries()) {
    restore(dir);
    try {
      applyMutant(dir, m);
    } catch (e) {
      rows.push(rowOf(m, { verdict: "error", line: `the mutant did not apply: ${e.message}`, seconds: 0 }));
      continue;
    }
    log(`schema mutant ${m.id}: the whole schema job`);
    const r = await withDatabase(adminUrl, `mut_job_${i}`, (url) => execIn(dir, process.execPath, ["scripts/ci/schema-apply.mjs"], { DATABASE_URL: url }, 30 * 60 * 1000));
    rows.push(rowOf(m, { ...judge("schema:apply", r), exit: r.code, seconds: Math.round(r.ms / 100) / 10 }));
    restore(dir);
  }
  return rows;
}

/** Run the schema-class mutants against `process.env.DATABASE_URL`, or an embedded PostgreSQL when it is not set. Returns the result rows. */
export async function runSchemaMutants({ dir, mutants, inventory, log }) {
  const run = async (adminUrl) => {
    const ctx = { dir, adminUrl, inventory, log };
    const groups = [
      [mutants.filter((m) => m.gate.startsWith("selfcheck:")), selfChecks],
      [mutants.filter((m) => m.gate.startsWith("property:")), properties],
      [mutants.filter((m) => m.gate === "schema:apply"), wholeJob],
    ];
    const rows = [];
    for (const [list, fn] of groups) if (list.length) rows.push(...(await fn({ ...ctx, mutants: list })));
    return rows;
  };
  return process.env.DATABASE_URL ? run(process.env.DATABASE_URL) : withEmbeddedPostgres(run, log);
}
