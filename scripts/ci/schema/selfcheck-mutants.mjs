// The mutants of the migration self-checks (tests/mutants/registry.json, gate `selfcheck:<id>` or `selfcheck:*`): for every migration, a transform (a module exporting `mutate(text)`) removes the change the file makes and keeps
// its self-check, or, for a file that makes no change (a self-check of other migrations' objects, a data assertion), breaks the thing it attacks; the mutated file is run in a transaction that rolls back, on the database as the
// chain left it BEFORE the file, and its self-check must fail: by its own RAISE EXCEPTION (SQLSTATE P0001) or because the table, function, column or constraint it reads or calls is not there. A self-check that passes with the change gone is `green`
// (it proves nothing); a failure that is not about the change (a statement that does not parse, a timeout) is `error`. A transform returns the mutated text, or `{ text, fixture: false }` to run a data file without its fixture, or null when it finds nothing to mutate.
// Used by `schema-apply.mjs --selfcheck-mutants <rules.json>`, rules being `[{ gate, transform }]` from the registry: an exact gate wins over the wildcard.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { selfCheckIdOf } from "../../lib/migrations.mjs";

import { rollbackSql } from "./data.mjs";

const RAISED = /\[SQLSTATE P0001\]/;
const SQLSTATE = /\[SQLSTATE (\w{5})\]/;
/** Failures that say nothing about the self-check: a statement that does not parse, a connection or a timeout. Anything else the database refuses (the object is not there, the constraint is not there) is the self-check failing for the missing change. */
const NOT_THE_CHECK = new Set(["42601", "42P02", "XX000", "57014", "57P01", "08006", "08003"]);
const unframe = (text) => text.replace(/^(BEGIN|COMMIT);[ \t]*$/gm, "");

/** The verdict of one mutated run from its stderr. */
export function verdictOf({ code, err }) {
  const lines = err.split("\n").filter((l) => /ERROR|FATAL/.test(l));
  if (!lines.length && code === 0) return { verdict: "green", line: "the self-check passed with the change removed" };
  const raised = lines.find((l) => RAISED.test(l));
  if (raised) return { verdict: "red", line: raised.replace(/^.*ERROR:\s*/, "").replace(RAISED, "").trim().slice(0, 200) };
  const first = lines[0] ?? err;
  const state = SQLSTATE.exec(first)?.[1];
  const text = first.replace(/^.*ERROR:\s*/, "").replace(SQLSTATE, "").trim().slice(0, 200);
  // The check read or called what the change makes (a table, a function, a column, a constraint) and the database refused: it failed for the missing change, which is what a self-check is for.
  if (state && !NOT_THE_CHECK.has(state)) return { verdict: "red", line: `${text} (SQLSTATE ${state}: the change it checks is not there)` };
  return { verdict: "error", line: `failed for a reason that is not the change: ${text}` };
}

export async function selfCheckMutantHooks(ctx, rulesPath) {
  const rules = JSON.parse(readFileSync(rulesPath, "utf8"));
  const transforms = new Map();
  for (const r of rules) transforms.set(r.gate, (await import(pathToFileURL(resolve(r.transform)).href)).mutate);
  const results = [];
  const run = (file, text, fixture) => {
    const id = selfCheckIdOf(text, file);
    const mutate = transforms.get(`selfcheck:${id}`) ?? transforms.get("selfcheck:*");
    if (!mutate) return;
    const made = mutate(text);
    const mutated = made === null ? null : typeof made === "string" ? { text: made } : made;
    if (mutated === null) return void results.push({ id, verdict: "error", line: `${file}: the transform found nothing to mutate` });
    const withFixture = fixture !== null && mutated.fixture !== false;
    const r = ctx.psql({ sql: withFixture ? rollbackSql({ fixture, body: mutated.text }) : `BEGIN;\n${unframe(mutated.text)}\nROLLBACK;\n` });
    results.push({ id, ...verdictOf(r) });
  };
  return {
    before: (file, text) => run(file, text, null),
    data: (file, text) => {
      const fixture = /^-- rollback-test: (\S+)$/m.exec(text)?.[1];
      run(file, text, fixture ? readFileSync(fixture, "utf8") : null);
    },
    report: () => {
      for (const r of results) console.log(`MUTANT selfcheck:${r.id} ${r.verdict} ${r.line}`);
    },
  };
}
