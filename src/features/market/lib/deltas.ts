// Ported from old_repo/src/lib/market/series-deltas.mjs (lines 1-152)
// Series deltas (INV-252): the latest observation against the observation nearest the window start that lies inside the window's tolerance, only when both carry the same unit and currency. No prior inside the tolerance is
// insufficient history (a 49-day-old prior is never a "1w" change), a unit or currency change is suppressed, and none of these ever prints 0.
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
/** The ages (days before the latest observation) a prior may have to stand for each window. */
const DELTA_TOLERANCE = Object.freeze({ w1: [5, 9], m1: [25, 35], yoy: [350, 380] } as const);
const dayMs = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

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

function windowDelta(points: Point[], latest: Point, days: number, [lo, hi]: readonly [number, number]): WindowDelta {
  if (points.length < 2 || !/^\d{4}-\d{2}-\d{2}/.test(latest.date)) return { insufficientHistory: true };
  const age = (p: Point): number => (dayMs(latest.date) - dayMs(p.date)) / 86_400_000;
  // The prior nearest the window start among those inside the tolerance (the older one on a tie); none inside it is no prior.
  const prior = points.filter((p) => age(p) >= lo && age(p) <= hi).reduce<Point | null>((best, p) => (!best || Math.abs(age(p) - days) < Math.abs(age(best) - days) || (Math.abs(age(p) - days) === Math.abs(age(best) - days) && p.date < best.date) ? p : best), null);
  if (!prior || latest.value === null || prior.value === null) return { insufficientHistory: true };
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
  return { count: points.length, latest: out, sparkline, delta1w: windowDelta(points, latest, DELTA_WINDOWS.w1, DELTA_TOLERANCE.w1), delta1m: windowDelta(points, latest, DELTA_WINDOWS.m1, DELTA_TOLERANCE.m1), deltaYoY: windowDelta(points, latest, DELTA_WINDOWS.yoy, DELTA_TOLERANCE.yoy), message: null };
}
