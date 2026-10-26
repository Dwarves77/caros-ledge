// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): a pattern detector as a registered derivation method (propagation/methods.ts registers the five under the method-version gate). When an evidence row of a stored pattern changes, the propagation drain resolves the pattern's
// declared inputs (the evidence rows, each with the entities it was filed under) and calls this method: the same detector runs over the same facts at the drain's clock, and the pattern stands only if it is found again over exactly those rows. A row that is gone, or no longer current,
// or a pattern that no longer holds, refuses and the value stays stale; the next connect stage supersedes it. No read is made here.
import type { MethodFn } from "@/core/propagation/methods";

import { PATTERNS } from "./config";
import { DETECTORS } from "./detect";
import { factOf, gradeOf } from "./facts";
import type { Fact, PatternKind } from "./types";

export function patternMethod(kind: PatternKind): MethodFn {
  return (ctx) => {
    const gone = ctx.inputs.filter((i) => !i.row).map((i) => `${i.table}/${i.pk}`);
    if (gone.length) return { ok: false, reason: `evidence is gone or no longer current: ${gone.join(", ")}` };
    // an obligation row is a ceiling in a penalty-abatement pattern and a ratchet in the others: the pattern's kind says which of the table's specs the evidence row was read as
    const role = kind === "penaltyAbatement" ? "ceiling" : "ratchet";
    const facts = ctx.inputs.map((i) => ({ fact: factOf(i.table, i.row as Record<string, unknown>, i.entities ?? [], { surface: i.surface, ...(i.at ? { at: i.at } : {}), role, now: ctx.now }), input: i }));
    if (facts.some((f) => !f.fact)) return { ok: false, reason: "an evidence table has no fact spec" };
    const all = facts.map((f) => f.fact as Fact);
    const relation = ctx.inputs.find((i) => i.relation)?.relation;
    const entities = [...new Set(all.flatMap((f) => f.entities))];
    const related = (e: string) => entities.filter((x) => x !== e).map((x) => ({ entity: x, relation: (relation ?? "implements") as never }));
    const prior = Number((ctx.priorValue as { value?: unknown } | null)?.value);
    const signature = ctx.inputs.map((i) => `${i.table}/${i.pk}`).sort().join();
    const found = DETECTORS[kind]({ now: ctx.now, facts: all, related, flow: null, ...(Number.isFinite(prior) ? { carry: prior } : {}) }).find((p) => p.evidence.map((e) => `${e.table}/${e.pk}`).sort().join() === signature);
    if (!found) return { ok: false, reason: "the pattern no longer holds over its evidence" };
    return { ok: true, value: found.value, unit: found.unit, derivation: "calculated", originClass: "derived", lifecycle: "emerging", admissibility: gradeOf(all), confidence: PATTERNS[kind].confidence, halfLifeDays: null, basis: found.key };
  };
}
