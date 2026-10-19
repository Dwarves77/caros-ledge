// INV-R2d-3 and register F:6 (the derivation ceiling): the ONE gate compares the use with the ceiling the value stored, and refuses a superseded value. One row per cell of tier x use x lifecycle.
import assert from "node:assert/strict";
import { test } from "node:test";

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
