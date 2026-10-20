// Ported from old_repo/src/components/ui/ImpactMeter.tsx (lines 36-111)
// The impact meter's pure parts. The ramp stops are one of the two declared colour exceptions: the ramp is interpolated in code (ruling B).
import type { ImpactScores } from "@/core/types";

const IMPACT_SEGMENTS = 12;
const IMPACT_GROUP_SIZE = 3;

/** True when at least one dimension is scored (1 to 3); a row of zeros is unscored, not a score of zero. */
export function isImpactScored(scores: ImpactScores | null | undefined): scores is ImpactScores {
  return !!scores && [scores.cost, scores.compliance, scores.client, scores.operational].some((v) => v >= 1);
}
export const sumScores = (s: ImpactScores): number => s.cost + s.compliance + s.client + s.operational;

const RAMP_STOPS: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [1, [0x16, 0xa3, 0x4a]],
  [4, [0xca, 0x8a, 0x04]],
  [7, [0xf9, 0x73, 0x16]],
  [12, [0xdc, 0x26, 0x26]],
];
const hex2 = (v: number): string => Math.round(v).toString(16).padStart(2, "0").toUpperCase();

/** The single fill colour of a row meter at total N (1 to 12), piecewise-linear between the stops. */
export function rampColor(n: number): string {
  const first = RAMP_STOPS[0]!;
  const last = RAMP_STOPS[RAMP_STOPS.length - 1]!;
  const x = Math.min(Math.max(n, first[0]), last[0]);
  for (let i = 0; i < RAMP_STOPS.length - 1; i += 1) {
    const [n0, c0] = RAMP_STOPS[i]!;
    const [n1, c1] = RAMP_STOPS[i + 1]!;
    if (x >= n0 && x <= n1) {
      const t = n1 === n0 ? 0 : (x - n0) / (n1 - n0);
      return `#${[0, 1, 2].map((k) => hex2(c0[k]! + (c1[k]! - c0[k]!) * t)).join("")}`;
    }
  }
  return `#${last[1].map(hex2).join("")}`;
}

/** Segment i (0-based) of a meter at total N is filled when i < N. */
export const segmentFilled = (n: number, i: number): boolean => i < n;

/** The 12 segments in four groups of three. */
export const SEGMENT_GROUPS: ReadonlyArray<readonly number[]> = Array.from({ length: IMPACT_SEGMENTS / IMPACT_GROUP_SIZE }, (_, g) => Array.from({ length: IMPACT_GROUP_SIZE }, (_, k) => g * IMPACT_GROUP_SIZE + k));
