// FIX-P1-1b: every count key a runtime reports is classed in families.json, as a write (it proves the run changed stored rows) or a read (it describes the work: a total, a plan, a refusal, a sub-count).
// The recorder (classify) records a run `noop` when none of its declared writes is above zero, so a key left out of both lists is a write nobody counted. It happened four times on production (patterns-apply, couplings-apply, retokenise, producers).
// The keys are collected from the ledger rows of the fixture turns (the whole turn, the coupling turn that mines and detects, the briefs backfill, a producer run), dry and apply, where the real stages and producers write them.
import assert from "node:assert/strict";
import { test } from "node:test";

import { FAMILIES } from "@/core/harness";
import { runTurn } from "@/core/turn";

import { connect, patternFixture } from "../coupling/_world.ts";
import { fixture, NOW } from "../integration/world.ts";
import type { Fixture } from "../integration/world.ts";

/** The keys of `counts` that its family classes neither as a write nor as a read. */
const undeclared = (family: string, counts: Record<string, unknown>): string[] => {
  const f = FAMILIES.find((x) => x.name === family);
  return Object.keys(counts).filter((k) => !f || (!f.writes.includes(k) && !f.reads.includes(k))).sort();
};
const ledgerKeys = (f: Fixture): Map<string, Set<string>> => {
  const out = new Map<string, Set<string>>();
  for (const row of f.db.rows("harness_runs")) {
    const o = row.outputs as { counts?: Record<string, unknown>; planned?: Record<string, unknown> } | null;
    for (const k of [...Object.keys(o?.counts ?? {}), ...Object.keys(o?.planned ?? {})]) out.set(String(row.family), (out.get(String(row.family)) ?? new Set()).add(k));
  }
  return out;
};
const run = (f: Fixture, mode: "dry" | "apply", stage: string, input: Record<string, unknown> = {}) => runTurn({ stage, mode, input } as never, { d: f.d, env: {}, now: () => NOW });

async function collected(): Promise<Map<string, Set<string>>> {
  const all = new Map<string, Set<string>>();
  const add = (f: Fixture) => { for (const [fam, ks] of ledgerKeys(f)) all.set(fam, new Set([...(all.get(fam) ?? []), ...ks])); };
  for (const mode of ["apply", "dry"] as const) {
    const turn = fixture();
    await run(turn, mode, "all", { intake: { census: { limit: 5 } }, propagate: { producers: { only: "ecb-fx" } }, briefs: { retokenise: { limit: 5 } } });
    add(turn);
  }
  const coupling = patternFixture();
  await connect(coupling);
  add(coupling);
  return all;
}

test("every count key the fixture turns report is classed in families.json as a write or a read", async () => {
  const keys = await collected();
  assert.ok(keys.size >= 6, `the fixture turns record ${keys.size} families`);
  const missing = [...keys].flatMap(([family, ks]) => undeclared(family, Object.fromEntries([...ks].map((k) => [k, 1]))).map((k) => `${family}.${k}`));
  assert.deepEqual(missing, [], "classify these in src/core/harness/data/families.json: a write if the run changed stored rows, else a read");
});

test("a key no list names is found: a planted count the families do not class", () => {
  assert.deepEqual(undeclared("corpus-turn", { patterns_new: 1, patterns_planted_by_a_test: 3, themes: 0 }), ["patterns_planted_by_a_test"]);
  assert.deepEqual(undeclared("no-such-family", { a: 1 }), ["a"]);
});

test("a key is a write or a read, never both", () => {
  for (const f of FAMILIES) assert.deepEqual(f.writes.filter((k) => f.reads.includes(k)), [], f.name);
});
