// Ported from old_repo/src/lib/sources/reachability.mjs (lines 1-61)
// Ported from old_repo/src/lib/sources/verification-decision.mjs (lines 1-16)
// Ported from old_repo/src/lib/sources/check-sources-decision.mjs (lines 1-24)
// Ported from old_repo/src/lib/sources/fetch-now-decision.mjs (lines 1-21)
import { isErrorBody } from "./classify-body";
import { type FetchDeps } from "./direct";
import { assertFetchAllowed } from "./hold";
import { PRIMARY_HEADERS } from "./policy";

export const REACH = { REACHABLE: "reachable", INCONCLUSIVE: "inconclusive", DEAD: "dead" } as const;
export type Reachability = (typeof REACH)[keyof typeof REACH];

/** One fetch result to a three-way verdict. A throw with no status is a non-answer; only a 404 or 410 is a definitive negative (INV-066). */
export function classifyReachability({ status, errored }: { status: number | null | undefined; errored: boolean }): Reachability {
  if (errored) return REACH.INCONCLUSIVE;
  if (status != null && status >= 200 && status < 300) return REACH.REACHABLE;
  if (status === 405) return REACH.REACHABLE;
  if (status === 404 || status === 410) return REACH.DEAD;
  return REACH.INCONCLUSIVE;
}

/** The verification action for a reachability outcome; null means proceed. */
export function reachabilityTier(outcome: Reachability): { tier: "M" | "L"; rejection_reason: string } | null {
  if (outcome === REACH.REACHABLE) return null;
  return outcome === REACH.INCONCLUSIVE ? { tier: "M", rejection_reason: "reachability_inconclusive" } : { tier: "L", rejection_reason: "reachability" };
}
export function decideReachabilityAction(outcome: Reachability): { shortCircuit: false } | { shortCircuit: true; tier: "M" | "L"; action: "queued-provisional" | "rejected"; rejection_reason: string } {
  const v = reachabilityTier(outcome);
  return v ? { shortCircuit: true, tier: v.tier, action: v.tier === "M" ? "queued-provisional" : "rejected", rejection_reason: v.rejection_reason } : { shortCircuit: false };
}

/** The outcome of a source check: only a definitive DEAD with a zero streak may consult the eviction guard; a non-answer never evicts. */
export function decideSourceAssessment({ outcome, source = {} }: { outcome: Reachability; source?: { status?: string | undefined; consecutive_accessible?: number | undefined } }) {
  if (outcome === REACH.REACHABLE) return { isAccessible: true, reactivate: source.status === "inaccessible", evictEligible: false, consecutive_accessible: (source.consecutive_accessible ?? 0) + 1 };
  return { isAccessible: false, reactivate: false, evictEligible: outcome === REACH.DEAD && (source.consecutive_accessible ?? 0) === 0, consecutive_accessible: 0 };
}

/** A fetch-now result to dead, inconclusive or ok; a status drives even when it arrives as a throw. */
export function decideFetchOutcome({ content, error }: { content?: string | null; error?: { status?: number; message?: string } | null }) {
  if (error) {
    const status = typeof error.status === "number" ? error.status : Number(String(error.message || "").match(/\b(\d{3})\b/)?.[1]) || undefined;
    return classifyReachability({ status, errored: status === undefined }) === REACH.DEAD ? { kind: "dead" as const, httpStatus: 502 } : { kind: "inconclusive" as const, httpStatus: 503 };
  }
  return isErrorBody(content) ? { kind: "inconclusive" as const, httpStatus: 503, reason: "error-body" } : { kind: "ok" as const, httpStatus: 200 };
}

export interface ReachabilityDeps extends FetchDeps {
  sleep?: (ms: number) => Promise<void>;
}
/** A HEAD (then a GET when the host answers 405) up to three times; REACHABLE and DEAD are terminal, a non-answer retries. The hold gate runs first. */
export async function checkReachability(url: string, deps: ReachabilityDeps, opts: { timeoutMs?: number; backoff?: number[]; maxAttempts?: number } = {}) {
  await assertFetchAllowed(url, deps.caller, deps);
  const { timeoutMs = 8000, backoff = [200, 800, 3200], maxAttempts = 3 } = opts;
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: { status: number | null; errored: boolean; error?: string } = { status: null, errored: true, error: "not attempted" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(backoff[attempt - 1] ?? 0);
    try {
      let res = await doFetch(url, { method: "HEAD", redirect: "follow", headers: PRIMARY_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 405) res = await doFetch(url, { method: "GET", redirect: "follow", headers: PRIMARY_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
      last = { status: res.status, errored: false };
    } catch (e) {
      last = { status: null, errored: true, error: e instanceof Error ? e.message : String(e) };
    }
    const outcome = classifyReachability(last);
    if (outcome !== REACH.INCONCLUSIVE) return { outcome, ok: outcome === REACH.REACHABLE, finalStatus: last.status, attempts: attempt };
  }
  return { outcome: classifyReachability(last), ok: false, finalStatus: last.status, attempts: maxAttempts, error: last.error };
}
