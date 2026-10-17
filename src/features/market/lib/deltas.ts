// Ported from old_repo/src/lib/market/series-deltas.mjs (lines 1-152)
// Series deltas (INV-252): the latest observation against the nearest at or before the window start, only when both carry the same unit and currency. No such point is insufficient history, a unit or currency change is
// suppressed, and none of these ever prints 0.
import { addDaysIso } from "../producers/published-price-statistics";

export interface SeriesObservation {
  series_key?: string | null;
  label?: string | null;
  reference_period?: string | null;
  as_at_date?: string | null;
  value_numeric?: number | string | null;
  unit?: string | null;
  currency?: string | null;
  [k: string]: unknown;
}
export interface WindowDelta {
  value?: number;
  pct?: number | null;
  fromDate?: string;
  kind?: "quantity";
  insufficientHistory?: boolean;
  unitMismatch?: boolean;
}
export interface DeltaPoint {
  date: string;
  value: number | null;
}
export interface SeriesDeltas {
  count: number;
  latest: { date: string; value: number | null; unit: string | null; currency: string | null } | null;
  sparkline: DeltaPoint[];
  delta1w: WindowDelta | null;
  delta1m: WindowDelta | null;
  deltaYoY: WindowDelta | null;
  message: string | null;
}

export const DELTA_WINDOWS = Object.freeze({ w1: 7, m1: 30, yoy: 365 });

interface Point extends DeltaPoint {
  unit: string | null;
  currency: string | null;
}
const numberOf = (raw: unknown): number | null => {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** Ascending by date, one point per date (a later-seen row wins a same-date collision). */
function toPoints(rows: readonly SeriesObservation[]): Point[] {
  const byDate = new Map<string, Point>();
  for (const r of rows) {
    const date = r.reference_period ?? r.as_at_date ?? null;
    if (date) byDate.set(date, { date, value: numberOf(r.value_numeric), unit: r.unit ?? null, currency: r.currency ?? null });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function windowDelta(points: Point[], latest: Point, days: number): WindowDelta {
  const target = /^\d{4}-\d{2}-\d{2}/.test(latest.date) ? addDaysIso(latest.date.slice(0, 10), -days) : null;
  if (points.length < 2 || !target) return { insufficientHistory: true };
  const prior = points.filter((p) => p.date <= target).reduce<Point | null>((best, p) => (!best || p.date > best.date ? p : best), null);
  if (!prior || prior.date === latest.date || latest.value === null || prior.value === null) return { insufficientHistory: true };
  if (prior.unit !== latest.unit || prior.currency !== latest.currency) return { unitMismatch: true, fromDate: prior.date };
  const value = latest.value - prior.value;
  return { value, pct: prior.value !== 0 ? (value / Math.abs(prior.value)) * 100 : null, fromDate: prior.date, kind: "quantity" };
}

/** The comparative shape of ONE series from its (unreduced) observation rows, in any order and count. */
export function computeSeriesDeltas(rows: readonly SeriesObservation[]): SeriesDeltas {
  const points = toPoints(rows ?? []);
  const sparkline = points.map(({ date, value }) => ({ date, value }));
  const latest = points[points.length - 1];
  if (!latest) return { count: 0, latest: null, sparkline, delta1w: null, delta1m: null, deltaYoY: null, message: "no observations on record" };
  const out = { date: latest.date, value: latest.value, unit: latest.unit, currency: latest.currency };
  if (points.length === 1) return { count: 1, latest: out, sparkline, delta1w: null, delta1m: null, deltaYoY: null, message: "one observation, no change to show yet" };
  return { count: points.length, latest: out, sparkline, delta1w: windowDelta(points, latest, DELTA_WINDOWS.w1), delta1m: windowDelta(points, latest, DELTA_WINDOWS.m1), deltaYoY: windowDelta(points, latest, DELTA_WINDOWS.yoy), message: null };
}
