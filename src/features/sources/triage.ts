// Ported from old_repo/scripts/sources/inaccessible-triage.mjs (lines 1-472)
import type { Db } from "@/core/db";
import { allRows } from "@/core/db";
import { fetchPrimaryWithFallback, generateCandidates } from "@/core/fetch/candidates";
import { fetchDirect, type FetchDeps } from "@/core/fetch/direct";
import { assertFetchAllowed } from "@/core/fetch/hold";
import { honestFetch } from "@/core/fetch/honest";
import { DECLARED_HEADERS } from "@/core/fetch/policy";
import { hostOf } from "@/core/shared";
import { classTierForHost } from "@/core/sources/host-class";
import { officialnessOf } from "@/core/sources/officialness";
import { outcomeOf, type RunDeps, type RunResult } from "@/core/sources/run-result";

export const DEFAULT_TIME_BUDGET_MIN = 20;
export const MAX_CONCURRENCY = 4;
export const DEFAULT_CONCURRENCY = 4;
/** Per-host politeness: never under one second between hits on the same host. */
export const DEFAULT_HOST_INTERVAL_MS = 1000;
const DEFAULT_PER_FETCH_MS = 20_000;
const MAX_SOURCES = 5000;

export interface SuspendedSource {
  id: string;
  url: string;
  name: string;
  base_tier: number | null;
  jurisdictions?: string[] | null;
}
export interface TriageDeps extends RunDeps, Omit<FetchDeps, "now"> {
  sleep?: (ms: number) => Promise<void>;
}
export interface TriageInput {
  apply?: boolean;
  limit?: number | null;
  concurrency?: number;
  hostIntervalMs?: number;
  perFetchMs?: number;
  timeBudgetMs?: number;
}

/** Per-host politeness: waitTurn resolves only once the minimum interval has passed since the last resolved turn for that host. */
export function createHostThrottle({ minIntervalMs = DEFAULT_HOST_INTERVAL_MS, now, sleep }: { minIntervalMs?: number; now: () => number; sleep: (ms: number) => Promise<void> }) {
  const lastHitAt = new Map<string, number>();
  return async (host: string): Promise<void> => {
    const elapsed = now() - (lastHitAt.get(host) ?? -Infinity);
    if (elapsed < minIntervalMs) await sleep(minIntervalMs - elapsed);
    lastHitAt.set(host, now());
  };
}
/** A concurrency-bounded runner with a hard deadline: once past it no NEW item starts. One entry per item. */
export async function runBounded<T, R>(items: T[], worker: (item: T) => Promise<R>, { concurrency = DEFAULT_CONCURRENCY, deadlineAt = Infinity, now }: { concurrency?: number; deadlineAt?: number; now: () => number }) {
  const results: Array<{ item: T; skipped: boolean; result?: R; error?: string }> = [];
  let idx = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      if (idx >= items.length) return;
      if (now() > deadlineAt) {
        for (; idx < items.length; idx++) results.push({ item: items[idx] as T, skipped: true });
        return;
      }
      const item = items[idx++] as T;
      try {
        results.push({ item, skipped: false, result: await worker(item) });
      } catch (e) {
        results.push({ item, skipped: false, error: (e as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, lane));
  return results;
}
/** An alternative qualifies at the source's floor iff its host classifies to a KNOWN tier (never a guess) at least as authoritative as the floor. */
export const qualifiesAtFloor = (hostTier: number | null, floorTier: number | null): boolean => hostTier != null && (floorTier == null || hostTier <= floorTier);

export type TriageOutcome = "recovered" | "alternative_found" | "still_inaccessible";
export interface Dossier {
  source_id: string;
  url: string;
  name: string;
  base_tier: number | null;
  probe: { head: { status: number | null; finalUrl: string; err?: string }; primary: Record<string, unknown> };
  ladder_steps: unknown[];
  outcome: TriageOutcome;
  evidence: Record<string, unknown>;
}
/** sources.fetch_status for a dossier, inside the column's CHECK: recovered is ok; a roadblock carries its reason; no determinate reason leaves it unchanged. */
export function fetchStatusForDossier(d: Pick<Dossier, "outcome" | "probe">): "ok" | "cdn_block" | "soft_404" | "blocked" | null {
  if (d.outcome === "recovered") return "ok";
  const reason = (d.probe?.primary?.reason as string | undefined) ?? null;
  if (!reason || reason === "ok") return null;
  return reason === "cdn_block" ? "cdn_block" : reason === "soft_404" ? "soft_404" : "blocked";
}

/** The ladder over one suspended source: a HEAD probe, the declared primary, a bounded alternative search, then same-floor qualification. Never promotes on content alone. */
export async function triageOneSource(source: SuspendedSource, deps: TriageDeps & { throttle: (host: string) => Promise<void>; perFetchMs: number }): Promise<Dossier> {
  const { throttle, perFetchMs } = deps;
  const url = source.url;
  const probeLog = new Map<string, { status: number; finalUrl?: string }>();
  const politeGet = async (u: string) => {
    await throttle(hostOf(u));
    const r = await fetchDirect(u, deps, { max: 500_000, timeoutMs: perFetchMs });
    probeLog.set(u, { status: r.status, ...(r.finalUrl ? { finalUrl: r.finalUrl } : {}) });
    return { text: r.text, status: r.status };
  };
  await throttle(hostOf(url));
  await assertFetchAllowed(url, deps.caller, deps);
  let head: Dossier["probe"]["head"];
  try {
    const r = await honestFetch(deps)(url, { method: "HEAD", headers: DECLARED_HEADERS, redirect: "follow", signal: AbortSignal.timeout(perFetchMs) });
    head = { status: r.status, finalUrl: r.url || url };
  } catch (e) {
    head = { status: null, finalUrl: url, err: (e as Error).message };
  }
  const identity = { title: source.name, jurisdiction: source.jurisdictions ?? null, sourceUrl: url };
  const pf = await fetchPrimaryWithFallback({ primaryUrl: url }, { fetchText: politeGet, discoverCandidates: () => generateCandidates(identity, {}), perFetchMs, maxCandidates: 6 });
  const primaryStep = pf.alternatives[0] as (typeof pf.alternatives)[number];
  const probe = { head, primary: { ...primaryStep, ...(probeLog.get(primaryStep.url) ?? {}) } };
  let outcome: TriageOutcome;
  let evidence: Record<string, unknown>;
  if (pf.ok && !pf.fellBack) {
    outcome = "recovered";
    evidence = { note: "declared primary now returns usable, in-language content directly (no fallback needed)." };
  } else if (pf.ok) {
    const altHost = hostOf(pf.url);
    const hostTier = classTierForHost(altHost);
    const floorTier = source.base_tier ?? null; // base_tier is the grounding stamp; effective_tier never confers eligibility
    const qualifies = qualifiesAtFloor(hostTier, floorTier);
    const off = officialnessOf(pf.text, altHost, { hostTier, floorTier });
    outcome = qualifies ? "alternative_found" : "still_inaccessible";
    evidence = { qualifiedUrl: pf.url, hostTier, floorTier, qualifies, officialness: { path: off.path, reason: off.reason, cleanLen: off.cleanLen, linkDensity: off.linkDensity }, note: qualifies ? "a bounded alternative was found and clears the source's own authority floor." : "a bounded alternative was fetchable but its host does not clear the source's authority floor: recorded as evidence, never promoted." };
  } else {
    outcome = "still_inaccessible";
    evidence = { note: "primary roadblocked; the bounded alternative search found no fetchable candidate.", candidatesTried: Math.max(0, pf.alternatives.length - 1) };
  }
  return { source_id: source.id, url, name: source.name, base_tier: source.base_tier ?? null, probe, ladder_steps: pf.alternatives, outcome, evidence };
}

/** Write fetch_status for the dossiers with a determinate status, one guarded group at a time; every write reads its error. */
export async function applyFetchStatus(db: Db, dossiers: Dossier[], stampIso: string): Promise<{ updated: number; errors: string[] }> {
  const groups = new Map<string, string[]>();
  for (const d of dossiers) {
    const status = fetchStatusForDossier(d);
    if (status) groups.set(status, [...(groups.get(status) ?? []), d.source_id]);
  }
  let updated = 0;
  const errors: string[] = [];
  for (const [status, ids] of groups) {
    const { data, error } = await db.from("sources").update({ fetch_status: status, fetch_status_at: stampIso }).in("id", ids).select("id");
    if (error) errors.push(`fetch_status=${status}: ${error.message}`);
    else updated += (data ?? []).length;
  }
  return { updated, errors };
}

/**
 * The ladder over every suspended source, concurrency-bounded (4 at most), one hit per host per second at most, inside a time budget. The hold gate runs in every fetch,
 * so a build-mode cadence of off refuses it. Dry by default: `apply` writes fetch_status.
 */
export async function triageSuspended(deps: TriageDeps, input: TriageInput = {}): Promise<RunResult<{ dossiers: Dossier[] }>> {
  const now = () => deps.now().getTime();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const throttle = createHostThrottle({ minIntervalMs: Math.max(DEFAULT_HOST_INTERVAL_MS, input.hostIntervalMs ?? DEFAULT_HOST_INTERVAL_MS), now, sleep });
  let sources: SuspendedSource[];
  try {
    sources = await allRows<SuspendedSource>(deps.db, "sources", "id, url, name, base_tier, jurisdictions", { cap: MAX_SOURCES, where: (q) => q.eq("status", "suspended") });
  } catch (e) {
    return { counts: { suspended: 0 }, outcome: "failed", notes: [`suspended-sources read failed: ${(e as Error).message}`] };
  }
  if (input.limit != null && input.limit > 0) sources = sources.slice(0, input.limit);
  const perFetchMs = Math.max(1000, input.perFetchMs ?? DEFAULT_PER_FETCH_MS);
  const deadlineAt = now() + Math.max(0.1, (input.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MIN * 60_000) / 60_000) * 60_000;
  const ran = await runBounded(sources, (s) => triageOneSource(s, { ...deps, throttle, perFetchMs }), { concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, input.concurrency ?? DEFAULT_CONCURRENCY)), deadlineAt, now });
  const dossiers = ran.filter((r) => !r.skipped && r.result).map((r) => r.result as Dossier);
  const errored = ran.filter((r) => r.error);
  const notes = errored.map((r) => `${r.item.url}: ${r.error}`);
  let applied = 0;
  if (input.apply && dossiers.length) {
    const w = await applyFetchStatus(deps.db, dossiers, deps.now().toISOString());
    applied = w.updated;
    notes.push(...w.errors);
  }
  const count = (o: TriageOutcome) => dossiers.filter((d) => d.outcome === o).length;
  return {
    counts: { suspended: sources.length, triaged: dossiers.length, skipped_time_budget: ran.filter((r) => r.skipped).length, errored: errored.length, recovered: count("recovered"), alternative_found: count("alternative_found"), still_inaccessible: count("still_inaccessible"), fetch_status_written: applied },
    outcome: outcomeOf(dossiers.length, errored.length + (notes.length - errored.length)),
    notes,
    data: { dossiers },
  };
}
