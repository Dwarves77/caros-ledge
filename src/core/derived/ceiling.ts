// The derivation ceiling (I14): the ONE function that decides whether a stored derived value may be used for a use. Uses rank display < analysis < calculation < filing; a value stores the highest use it
// may serve (`admissibility`: display_only < analysis_ok < calculation_ok < filing_ok), and a use above that ceiling is refused. A superseded, falsified or obsolete value serves no use at all, and a
// stale one waits for its recompute. The database carries the same rule (migration 0090: derived_values_admissible hides the dead lifecycles and carries ceiling_rank; derived_values_for_use(p_use)
// returns the rows whose ceiling reaches the use); tests/derived/gate.test.ts runs one row per (ceiling x use x lifecycle) cell and the migration's self-check runs the same cells in SQL.
import type { Admissibility, Lifecycle, Use } from "@/core/propagation/types";

/** The uses, lowest to highest. */
const USE_RANK: Readonly<Record<Use, number>> = Object.freeze({ display: 0, analysis: 1, calculation: 2, filing: 3 });
const CEILING_RANK: Readonly<Record<Exclude<Admissibility, "stale">, number>> = Object.freeze({ display_only: 0, analysis_ok: 1, calculation_ok: 2, filing_ok: 3 });
const DEAD: ReadonlySet<Lifecycle> = new Set<Lifecycle>(["falsified", "obsolete"]);

export type UseVerdict = { ok: true } | { ok: false; reason: string };

/** Refuse a value for a use it may not serve: a dead lifecycle, a stale value, or a use above its stored ceiling. */
export function assertUse(row: { lifecycle: Lifecycle; admissibility: Admissibility }, use: Use): UseVerdict {
  if (row.lifecycle === "superseded") return { ok: false, reason: "superseded: a newer value stands in its place" };
  if (DEAD.has(row.lifecycle)) return { ok: false, reason: "lifecycle" };
  if (row.admissibility === "stale") return { ok: false, reason: "pending recompute" };
  const ceiling = CEILING_RANK[row.admissibility];
  return ceiling === undefined || USE_RANK[use] > ceiling ? { ok: false, reason: `above its ceiling (${row.admissibility})` } : { ok: true };
}
