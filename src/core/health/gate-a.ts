// Ported from old_repo/src/lib/health/gate-a-gauges.mjs (lines 1-121)

export const ALARM_GAUGES = ["invariant_violations", "briefless_verified", "no_gatestate_verified", "verified_failing_revalidation"] as const;
const INFO_GAUGES = ["verified_gen_ver_null_info"] as const;
export const GAUGE_NAMES: readonly string[] = [...ALARM_GAUGES, ...INFO_GAUGES];
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
export function shapeGateAHealth({ data = null, error = null, thrown = null, now }: { data?: unknown; error?: { message: string } | null; thrown?: string | null; now: Date }): Record<string, Gauge> {
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
/** The probe verdict over the endpoint's gate_a object: fail on an unreadable gauge or a computed alarm above 0; not_computed warns. */
export function decideGateAProbe(gate_a: unknown): { fail: boolean; lines: string[] } {
  const lines: string[] = [];
  let fail = false;
  let notComputed = 0;
  for (const n of ALARM_GAUGES) {
    const g = (gate_a && typeof gate_a === "object" ? (gate_a as Record<string, Gauge | undefined>)[n] : undefined) as Gauge | undefined;
    if (!g || typeof g !== "object" || typeof g.state !== "string") {
      lines.push(`ERROR gate_a.${n} state=unreadable (gauge absent or old shape: a bare value where {value,state} is expected), fail-closed`);
      fail = true;
    } else if (g.state === "computed") {
      if (!Number.isInteger(g.value) || (g.value as number) < 0) {
        lines.push(`ERROR gate_a.${n} state=unreadable (computed with value ${JSON.stringify(g.value)}), fail-closed`);
        fail = true;
      } else if ((g.value as number) > 0) {
        lines.push(`ERROR gate_a.${n} state=computed ALARM value=${g.value} (must be 0)`);
        fail = true;
      } else lines.push(`ok gate_a.${n} state=computed value=0 computed_at=${g.computed_at}`);
    } else if (g.state === "not_computed") {
      notComputed++;
      lines.push(`WARNING gate_a.${n} state=not_computed: ${g.reason}`);
    } else {
      lines.push(`ERROR gate_a.${n} state=${g.state}: ${g.reason ?? "no reason given"}, fail-closed`);
      fail = true;
    }
  }
  if (!fail && notComputed > 0) lines.push(`WARNING ${notComputed} of ${ALARM_GAUGES.length} Gate A alarms are not_computed, not zero: the assertion did not run on live counts`);
  return { fail, lines };
}
