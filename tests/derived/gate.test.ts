// INV-R2d-3 and register F:6 (the derivation ceiling): the ONE gate compares the use with the ceiling the value stored, and refuses a superseded value. One row per cell of tier x use x lifecycle.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { assertUse } from "@/core/derived/ceiling";
import { admissibleFor } from "@/core/propagation";
import type { Admissibility, Lifecycle, Use, Value } from "@/core/propagation";

const NOW = new Date("2026-10-15T00:00:00Z");
const value = (over: Partial<Value> = {}): Value => ({
  valueId: "v", entityId: null, methodId: "m", methodVersion: "1", value: 1, valueLow: null, valueHigh: null, unit: null, currency: null, derivation: "calculated", originClass: "derived",
  lifecycle: "verified", admissibility: "filing_ok", baseConfidence: 0.99, assertedAt: NOW.toISOString(), halfLifeDays: null, inputs: [], supersedes: null, computedAt: NOW.toISOString(), computedBy: "t", ...over,
});

const CEILING: Record<Exclude<Admissibility, "stale">, number> = { display_only: 0, analysis_ok: 1, calculation_ok: 2, filing_ok: 3 };
const USES: Use[] = ["display", "analysis", "calculation", "filing"];
const LIFECYCLES: Lifecycle[] = ["emerging", "strengthening", "corroborated", "verified", "stalled", "falsified", "superseded", "obsolete"];

test("INV-R2d-3: every (ceiling x use x lifecycle) cell: a use above the stored ceiling is refused, a superseded, falsified or obsolete value is refused for every use, anything else is admitted", () => {
  for (const [tier, rank] of Object.entries(CEILING) as [Exclude<Admissibility, "stale">, number][]) {
    for (const use of USES) {
      for (const lifecycle of LIFECYCLES) {
        const v = admissibleFor(value({ admissibility: tier, lifecycle }), use, NOW);
        const refusedByLifecycle = lifecycle === "superseded" || lifecycle === "falsified" || lifecycle === "obsolete";
        const aboveCeiling = USES.indexOf(use) > rank;
        assert.equal(v.ok, !(refusedByLifecycle || aboveCeiling), `${tier} / ${use} / ${lifecycle}`);
      }
    }
  }
});

test("the reproduced probe: a display_only superseded value admitting a filing use is refused, by the lifecycle and by the ceiling, and each refusal says which", () => {
  const probe = value({ admissibility: "display_only", lifecycle: "superseded", baseConfidence: 0.99, derivation: "calculated" });
  const r = admissibleFor(probe, "filing", NOW);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /superseded/);
  const onlyCeiling = admissibleFor(value({ admissibility: "display_only", lifecycle: "verified" }), "filing", NOW);
  assert.equal(onlyCeiling.ok, false);
  assert.match((onlyCeiling as { reason: string }).reason, /ceiling/);
  assert.equal(admissibleFor(probe, "display", NOW).ok, false, "a superseded value is history for every use, display included");
});

test("a value is admitted at exactly its ceiling and below it, with the decayed confidence and its origin label", () => {
  const v = admissibleFor(value({ admissibility: "calculation_ok", baseConfidence: 0.8 }), "calculation", NOW);
  assert.deepEqual(v, { ok: true, effectiveConfidence: 0.8, mustLabel: "derived" });
  assert.equal(admissibleFor(value({ admissibility: "calculation_ok", baseConfidence: 0.8 }), "analysis", NOW).ok, true);
  assert.equal(admissibleFor(value({ admissibility: "calculation_ok", baseConfidence: 0.99 }), "filing", NOW).ok, false);
});

// ---- assertUse: the one function (core/derived/ceiling.ts) and its SQL twin ----
test("INV-R2d-3: assertUse refuses a use above the stored ceiling and a superseded, falsified, obsolete or stale value, with the reason, for every cell", () => {
  const ladder: Record<string, Use[]> = { display_only: ["display"], analysis_ok: ["display", "analysis"], calculation_ok: ["display", "analysis", "calculation"], filing_ok: ["display", "analysis", "calculation", "filing"] };
  for (const [tier, admitted] of Object.entries(ladder)) {
    for (const use of USES) {
      const v = assertUse({ lifecycle: "verified", admissibility: tier as Admissibility }, use);
      assert.equal(v.ok, admitted.includes(use), `${tier} / ${use}`);
      if (!v.ok) assert.match(v.reason, /above its ceiling/);
    }
  }
  assert.deepEqual(assertUse({ lifecycle: "superseded", admissibility: "filing_ok" }, "display"), { ok: false, reason: "superseded: a newer value stands in its place" }, "a superseded value serves no use, display included");
  assert.deepEqual(assertUse({ lifecycle: "falsified", admissibility: "filing_ok" }, "analysis"), { ok: false, reason: "lifecycle" });
  assert.deepEqual(assertUse({ lifecycle: "obsolete", admissibility: "filing_ok" }, "analysis"), { ok: false, reason: "lifecycle" });
  assert.deepEqual(assertUse({ lifecycle: "verified", admissibility: "stale" }, "display"), { ok: false, reason: "pending recompute" });
  assert.deepEqual(assertUse({ lifecycle: "stalled", admissibility: "analysis_ok" }, "analysis"), { ok: true }, "stalled and emerging are live lifecycles");
});

test("INV-R2d-3: the SQL view and function carry the same ladder and the same dead lifecycles (migration 0090), and its self-check runs the cells", () => {
  const sql = readFileSync("supabase/migrations/0090_derived_values_ceiling.sql", "utf8");
  assert.match(sql, /WHEN 'display_only' THEN 0 WHEN 'analysis_ok' THEN 1 WHEN 'calculation_ok' THEN 2 WHEN 'filing_ok' THEN 3/);
  assert.match(sql, /ARRAY\['falsified'::text, 'obsolete'::text, 'superseded'::text\]/);
  assert.match(sql, /CASE p_use WHEN 'display' THEN 0 WHEN 'analysis' THEN 1 WHEN 'calculation' THEN 2 WHEN 'filing' THEN 3/);
  for (const cell of ["sup-display", "ok-display", "ok-calc", "ok-filing"]) assert.ok(sql.includes(`'${cell}'`), `the self-check plants ${cell}`);
  assert.ok(readFileSync("src/core/derived/ceiling.ts", "utf8").includes("display_only: 0, analysis_ok: 1, calculation_ok: 2, filing_ok: 3"), "the TypeScript ladder is the same four ranks");
});
