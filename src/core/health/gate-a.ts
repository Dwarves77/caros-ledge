// Ported from old_repo/src/lib/health/gate-a-gauges.mjs (lines 1-121)

const ALARM_GAUGES = ["invariant_violations", "briefless_verified", "no_gatestate_verified", "verified_failing_revalidation"] as const;
const INFO_GAUGES = ["verified_gen_ver_null_info"] as const;
const GAUGE_NAMES: readonly string[] = [...ALARM_GAUGES, ...INFO_GAUGES];
const EMPTY_PREFIX = "gate_a_health cache empty";
const STALE_RE = /^gate_a_health cache stale since (.+)$/;

export type GaugeState = "computed" | "not_computed" | "unreadable";
export interface Gauge {
  value: number | null;
  state: GaugeState;
  computed_at: string | null;
  reason: string | null;
}
const allGauges = (state: GaugeState, reason: string, computed_at: string | null): Record<string, Gauge> => Object.fromEntries(GAUGE_NAMES.map((n) => [n, { value: null, state, computed_at, reason }]));
function ageText(since: string, now: Date): string | null {
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60000));
  return mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
}

/** One gate_a_health() result as five gauges {value, state, computed_at, reason}, never a bare null. not_computed (cache empty or stale: the refresh is deliberately unscheduled) is the expected build-mode state. */
function shapeGateAHealth({ data = null, error = null, thrown = null, now }: { data?: unknown; error?: { message: string } | null; thrown?: string | null; now: Date }): Record<string, Gauge> {
  if (thrown) return allGauges("unreadable", `gate_a_health threw: ${thrown}`, null);
  if (error) return allGauges("unreadable", `gate_a_health rpc error: ${error.message}`, null);
  if (!data || typeof data !== "object" || Array.isArray(data)) return allGauges("unreadable", "gate_a_health returned no object", null);
  const d = data as Record<string, unknown>;
  if (typeof d.error === "string") {
    if (d.error.startsWith(EMPTY_PREFIX)) return allGauges("not_computed", "cache empty: the refresh has never run (it is deliberately unscheduled)", null);
    const m = STALE_RE.exec(d.error);
    if (m?.[1]) {
      const age = ageText(m[1], now);
      return allGauges("not_computed", `cache stale since ${m[1]}${age ? ` (age ${age}, TTL 30 minutes)` : ""}: the refresh is deliberately unscheduled`, m[1]);
    }
    return allGauges("unreadable", `gate_a_health reported an unrecognised error: ${d.error}`, null);
  }
  const computed_at = typeof d.computed_at === "string" ? d.computed_at : null;
  return Object.fromEntries(GAUGE_NAMES.map((n) => {
    const v = d[n];
    return [n, typeof v === "number" && Number.isInteger(v) && v >= 0 ? { value: v, state: "computed", computed_at, reason: null } : { value: null, state: "unreadable", computed_at, reason: `gauge ${n} is missing or not a non-negative integer in the cache payload` }];
  }));
}
/** Call the RPC through an injected client and shape the result. Never throws. */
export async function readGateAHealth(db: { rpc: (name: string) => PromiseLike<{ data: unknown; error: { message: string } | null }> }, now: Date): Promise<Record<string, Gauge>> {
  try {
    const { data, error } = await db.rpc("gate_a_health");
    return shapeGateAHealth({ data, error, now });
  } catch (e) {
    return shapeGateAHealth({ thrown: e instanceof Error ? e.message : "threw", now });
  }
}
