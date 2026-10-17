// New in P2-12: what the coverage line under a list draws, on P2-10's one model (coverageLineModel). The link is ALWAYS present; a refused or unavailable read is the unavailable state (the Absence token with a
// stated note beside the link), and "not covered yet" is only the state of a SUCCESSFUL read that returns zero. One function so the component and its test agree.
import { formatDenominatorLine } from "@/core/coverage";
import type { DenominatorLine } from "@/core/coverage/matrix";
import { coverageLineModel, type CoverageLineModel } from "@/features/regulations/coverage-line";

export interface DenominatorLineView extends CoverageLineModel {
  /** The stated count line, or null when there is none to state (unavailable, or an empty catalogue). */
  text: string | null;
}
export function denominatorLineView(denominator: DenominatorLine | null, error: string | null, surface: string): DenominatorLineView {
  const m = coverageLineModel(denominator, error !== null, surface);
  return { ...m, text: m.state === "count" && denominator ? formatDenominatorLine(denominator) : null };
}
