// Ported from old_repo/src/components/ui/Absence.tsx (lines 9-65)
// The absence vocabulary (INV-216): a missing value names the data it needs; "pending", "unscored" and "not scored" never render.
export type AbsenceReason = "not in primary source" | "pending" | "unscored" | "connect data";

/** A row carries at most one reason, by this precedence. "unscored" is never chosen: it has no precedence slot. */
const PRECEDENCE: readonly AbsenceReason[] = ["connect data", "not in primary source", "pending"];
export function pickAbsenceReason(candidates: (AbsenceReason | null | undefined)[]): AbsenceReason | null {
  return PRECEDENCE.find((reason) => candidates.includes(reason)) ?? null;
}

export const NEEDS_PHRASE: Readonly<Record<AbsenceReason, string>> = {
  "not in primary source": "needs primary-source figure",
  pending: "needs more data",
  unscored: "needs scoring inputs",
  "connect data": "connect ↗",
};
/** The glyph is written as the escape so no literal dash character sits in the source. */
export const ABSENCE_DASH = "—";
