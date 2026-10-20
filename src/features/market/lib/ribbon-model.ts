// Ported from old_repo/src/components/market/MarketComparativeRibbon.tsx (lines 108-244)
// What one headline card draws: each change window as an arrow and an unsigned magnitude, or the spec 00 section 4 state it falls in (with its SDMX code), and a one-year sparkline. Never a bare dash and never the word "pending".
import { formatDelta } from "@/core/contracts";

import { addDaysIso } from "../producers/published-price-statistics";

import { DELTA_WINDOWS, type DeltaPoint, type SeriesDeltas } from "./deltas";

export type DeltaAbsentState = "no_data_yet" | "not_covered" | "suppressed" | "not_applicable";
const DELTA_STATE_OBS_CODE: Readonly<Record<DeltaAbsentState, "H" | "L" | "Q" | "O">> = { no_data_yet: "H", not_covered: "L", suppressed: "Q", not_applicable: "O" };
const DELTA_STATE_LABEL: Readonly<Record<DeltaAbsentState, string>> = { no_data_yet: "no data yet", not_covered: "not covered", suppressed: "suppressed", not_applicable: "not applicable" };

export type WindowKey = "1w" | "1m" | "YoY";
const WINDOW_DAYS: Record<WindowKey, number> = { "1w": DELTA_WINDOWS.w1, "1m": DELTA_WINDOWS.m1, YoY: DELTA_WINDOWS.yoy };

export type DeltaCellModel =
  | { kind: "value"; window: WindowKey; arrow: string; magnitude: string; fromDate: string | undefined; text: string }
  | { kind: "absent"; window: WindowKey; lead: string; state: DeltaAbsentState; obsStatus: "H" | "L" | "Q" | "O"; label: string; detail: string };

/** An absent slot. `lead` is the visible prefix naming the slot (the window, or "trend", "as of", "value"). */
export const absentCell = (window: WindowKey, state: DeltaAbsentState, detail: string, lead: string = window): DeltaCellModel => ({ kind: "absent", window, lead, state, obsStatus: DELTA_STATE_OBS_CODE[state], label: DELTA_STATE_LABEL[state], detail });

/** One change window: a number, or the state it is in. `deltas` undefined means the row carries no comparison at all. */
export function deltaCellModel(deltas: SeriesDeltas | undefined, window: WindowKey): DeltaCellModel {
  if (!deltas) return absentCell(window, "not_covered", "No comparison is computed for this series.", "comparison");
  const delta = window === "1w" ? deltas.delta1w : window === "1m" ? deltas.delta1m : deltas.deltaYoY;
  const first = deltas.sparkline[0]?.date;
  const needs = `Needs ${WINDOW_DAYS[window]} days of history for the ${window} change.`;
  if (!delta) return absentCell(window, "no_data_yet", deltas.count === 0 ? "No observations on record yet." : deltas.count === 1 ? `One observation on record${first ? `, ${first}` : ""}. ${needs}` : needs);
  if (delta.unitMismatch) return absentCell(window, "suppressed", `Unit or currency changed since ${delta.fromDate}. The ${window} change is withheld rather than compared across a unit change.`);
  if (delta.insufficientHistory || typeof delta.value !== "number") return absentCell(window, "no_data_yet", `${needs}${first ? ` First observation ${first}.` : ""}`);
  if (typeof delta.pct !== "number") return absentCell(window, "not_applicable", `A percent change is undefined: the value on ${delta.fromDate} was zero.`);
  // Direction is a glyph and magnitude is unsigned, so the sign formatDelta emits is dropped; the percent move is never percentage points.
  const arrow = delta.pct > 0 ? "▲" : delta.pct < 0 ? "▼" : "";
  const magnitude = formatDelta(Math.abs(delta.pct), "quantity")?.replace(/^[+−]/, "") ?? "";
  return { kind: "value", window, arrow, magnitude, fromDate: delta.fromDate, text: `${arrow}${magnitude} ${window}` };
}

const SPARKLINE_MAX_POINTS = 60;
export const SPARK_W = 100;
export const SPARK_H = 24;
const SPARK_PAD = 2;
export interface SparklineModel {
  /** SVG `points` in a 100 by 24 box. */
  points: string;
  drawn: number;
  total: number;
  from: string;
  to: string;
}

/**
 * The geometry of a series over its last year of observations (counted back from the series' own latest date, never the clock; the window matches the year-over-year change), sampled to at most 60 points, or null when fewer
 * than two numeric points fall in it. A flat series draws a level line.
 */
export function sparklineModel(sparkline: readonly DeltaPoint[] | undefined, maxPoints = SPARKLINE_MAX_POINTS): SparklineModel | null {
  const numeric = (sparkline ?? []).filter((p): p is { date: string; value: number } => typeof p?.value === "number" && Number.isFinite(p.value));
  const last = numeric[numeric.length - 1]?.date;
  const cutoff = last && /^\d{4}-\d{2}-\d{2}/.test(last) ? addDaysIso(last.slice(0, 10), -DELTA_WINDOWS.yoy) : null;
  const valid = cutoff ? numeric.filter((p) => p.date >= cutoff) : numeric;
  if (valid.length < 2) return null;
  const picked = valid.length > maxPoints ? Array.from({ length: maxPoints }, (_, i) => valid[Math.round((i * (valid.length - 1)) / (maxPoints - 1))] as { date: string; value: number }) : valid;
  const values = picked.map((p) => p.value);
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  const points = picked.map((p, i) => `${((i / (picked.length - 1)) * SPARK_W).toFixed(2)},${(span === 0 ? SPARK_H / 2 : SPARK_PAD + (1 - (p.value - min) / span) * (SPARK_H - 2 * SPARK_PAD)).toFixed(2)}`).join(" ");
  return { points, drawn: picked.length, total: valid.length, from: (picked[0] as { date: string }).date, to: (picked[picked.length - 1] as { date: string }).date };
}
