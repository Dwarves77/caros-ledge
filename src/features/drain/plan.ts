// Ported from old_repo/scripts/drain/plan-drain.mjs (lines 1-311)
// Ported from old_repo/scripts/drain/artifact.mjs (lines 1-72)
// The judgement drain planner. STEP 0 reads the switches and, when off, plans nothing and reads nothing else (INV-106). Each kind's exporter is a function called in-process;
// every planned item with a uuid lease key is leased three hours by the run holder (one lease per uuid), anything leased by another holder or carrying a non-uuid key is named
// residue; a stale plan refuses without a live prompt_version; batches are numbered from the committed directory. `finishDrain` releases every lease and returns the run body.
import type { Db } from "@/core/db";
import { readDrainSwitch, type DrainSwitchState } from "@/core/drain/switch";

import { DEFAULT_MODE, DRAIN_KINDS, KIND_ORDER, kindModes, nextBatchPath, resolveKind, type DrainKind, type ExportResult, type Exporter, type Item } from "./kinds";

const PLAN_SCHEMA = "judgement-drain-plan-1";
const LEASE_LANE = "judgement-drain";
const LEASE_STALE_SECONDS = 3 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_KEYS = ["created_at", "first_seen_at", "discovered_at", "pending_since"];

export interface DrainDeps {
  readSwitch(): Promise<DrainSwitchState>;
  /** One exporter function per kind id (the slices that own a queue supply theirs). */
  exporters: Readonly<Record<string, Exporter>>;
  listBatchDir(kind: DrainKind): string[];
  acquire(leaseId: string, holder: string, lane: string, staleSeconds: number): Promise<{ acquired: boolean; cur_holder?: string | null }>;
  release(leaseId: string, holder: string): Promise<boolean>;
  now(): Date;
}
export interface PlanLease { kind: string; id: string; lease_id: string; holder: string; released: boolean; release_error?: string | null }
export interface PlanKind {
  kind: string; mode: string; label: string; pending_exported: number; export_error: string | null; source: unknown; earliest_pending: string | null; apply_step: string; authoring_guide: DrainKind["authoringGuide"]; batch_size: number;
  batches: Array<{ batch_path: string; item_ids: string[]; count: number }>; residue: { lease_held: Array<{ id: string; holder: string | null; reason: string }>; over_cap: number; not_stale?: number }; would_lease?: number;
}
export interface DrainPlan {
  schema: typeof PLAN_SCHEMA; run_id: string; generated_at: string; drain: "on" | "off"; dry?: true; switch: DrainSwitchState; holder: string; kinds: PlanKind[]; leases: PlanLease[];
  totals: { kinds_planned: number; batches: number; items: number; leases_held: number };
}

function earliestPending(items: readonly Item[]): string | null {
  let best: string | null = null;
  for (const it of items) for (const k of DATE_KEYS) {
    const v = it?.[k];
    if (typeof v === "string" && !Number.isNaN(Date.parse(v)) && (best === null || Date.parse(v) < Date.parse(best))) best = v;
  }
  return best;
}
/** Oldest pending first; kinds with no dated item after those with one; ties by the fixed kind order. */
function orderKinds<T extends { id: string; earliest: string | null }>(rows: readonly T[]): T[] {
  const rank = (id: string) => { const i = KIND_ORDER.indexOf(id); return i === -1 ? KIND_ORDER.length : i; };
  return [...rows].sort((a, b) => (a.earliest && b.earliest && a.earliest !== b.earliest ? Date.parse(a.earliest) - Date.parse(b.earliest) : a.earliest && !b.earliest ? -1 : !a.earliest && b.earliest ? 1 : rank(a.id) - rank(b.id)));
}
/** Items whose committed verdict is under a prompt_version other than the live one, oldest first. */
function selectStaleItems(items: readonly Item[], currentVersion: string): Item[] {
  const t = (v: unknown) => { const n = Date.parse(String(v)); return Number.isNaN(n) ? Infinity : n; };
  return items.filter((it) => typeof it?.verdict_prompt_version === "string" && it.verdict_prompt_version !== currentVersion).sort((a, b) => t(a.first_seen_at) - t(b.first_seen_at) || String(a.candidate_id ?? a.id ?? "").localeCompare(String(b.candidate_id ?? b.id ?? "")));
}

async function exportQueue(deps: DrainDeps, kind: DrainKind, opts: { limit: number; mode: string }): Promise<ExportResult> {
  const fn = deps.exporters[kind.id];
  if (!fn) return { ok: false, items: [], error: `no exporter function supplied for kind ${kind.id}` };
  try {
    return await fn(opts);
  } catch (e) {
    return { ok: false, items: [], error: (e as Error).message };
  }
}

export async function planDrain(deps: DrainDeps, input: { runId: string; limit?: number | null; kindId?: string | null; mode?: string; dry?: boolean; /** Plan only these kinds (the command passes the kinds it has an exporter for); absent, every kind. */ kinds?: readonly string[] }): Promise<DrainPlan> {
  const { runId, limit = null, kindId = null, mode = DEFAULT_MODE, dry = false } = input;
  const holder = `drain-${runId}`;
  const only = kindId ? resolveKind(kindId) : null;
  if (kindId && !only) throw new Error(`planDrain: unknown kind "${kindId}"`);
  if (mode !== DEFAULT_MODE) {
    if (!only) throw new Error(`planDrain: mode "${mode}" requires a kind`);
    if (!kindModes(only).includes(mode)) throw new Error(`kind ${only.id} has no mode "${mode}" (modes: ${kindModes(only).join(", ")})`);
  }
  const sw = await deps.readSwitch(); // STEP 0: the first and, when off, the only read.
  const head = { schema: PLAN_SCHEMA, run_id: runId, generated_at: deps.now().toISOString(), switch: sw, holder } as const;
  if (!sw.on) return { ...head, drain: "off", kinds: [], leases: [], totals: { kinds_planned: 0, batches: 0, items: 0, leases_held: 0 } };

  const raw: Array<{ id: string; kind: DrainKind; items: Item[]; source: unknown; error: string | null; notStale: number; earliest: string | null }> = [];
  for (const kind of only ? [only] : DRAIN_KINDS.filter((k) => !input.kinds || input.kinds.includes(k.id))) {
    const res = await exportQueue(deps, kind, { limit: limit ?? kind.batchSize * kind.maxBatchesPerRun, mode });
    let items = res.ok ? res.items : [];
    let error = res.ok ? null : (res.error ?? "export failed");
    let notStale = 0;
    if (mode === "stale" && res.ok) {
      if (typeof res.current_prompt_version !== "string" || !res.current_prompt_version) {
        error = "stale export did not report the live prompt_version, so staleness cannot be decided";
        items = [];
      } else {
        const kept = selectStaleItems(items, res.current_prompt_version);
        notStale = items.length - kept.length;
        items = kept;
      }
    }
    raw.push({ id: kind.id, kind, items, source: res.source ?? null, error, notStale, earliest: earliestPending(items) });
  }
  const leases: PlanLease[] = [];
  const kinds: PlanKind[] = [];
  try {
    for (const r of orderKinds(raw)) {
      const { kind } = r;
      const take = r.items.slice(0, kind.batchSize * kind.maxBatchesPerRun);
      const entry: PlanKind = { kind: kind.id, mode, label: kind.label, pending_exported: r.items.length + r.notStale, export_error: r.error, source: r.source, earliest_pending: r.earliest, apply_step: kind.applyStep, authoring_guide: kind.authoringGuide, batch_size: kind.batchSize, batches: [], residue: { lease_held: [], over_cap: Math.max(0, r.items.length - take.length), ...(mode === "stale" ? { not_stale: r.notStale } : {}) } };
      const existing = deps.listBatchDir(kind);
      const wouldLease = new Set<string>();
      const batches: string[][] = [];
      let current: string[] = [];
      for (const item of take) {
        const id = String(item?.[kind.idKey] ?? "");
        if (!id) continue;
        const leaseId = kind.leaseKey ? String(item?.[kind.leaseKey] ?? "") : "";
        if (leaseId) {
          if (!UUID.test(leaseId)) { entry.residue.lease_held.push({ id, holder: null, reason: "lease key is not a uuid" }); continue; }
          if (dry) wouldLease.add(leaseId);
          else if (!leases.some((l) => l.lease_id === leaseId)) {
            const got = await deps.acquire(leaseId, holder, LEASE_LANE, LEASE_STALE_SECONDS);
            if (!got.acquired && got.cur_holder !== holder) { entry.residue.lease_held.push({ id, holder: got.cur_holder ?? null, reason: "leased by another session" }); continue; }
            if (got.acquired) leases.push({ kind: kind.id, id, lease_id: leaseId, holder, released: false });
          }
        }
        current.push(id);
        if (current.length >= kind.batchSize) {
          batches.push(current);
          current = [];
        }
      }
      if (current.length) batches.push(current);
      entry.batches = batches.map((ids, i) => ({ batch_path: nextBatchPath(kind, existing, i), item_ids: ids, count: ids.length }));
      if (dry) entry.would_lease = wouldLease.size;
      kinds.push(entry);
    }
  } catch (e) {
    // INV-DIG-4: a failure part way through (a lease call, a directory listing) releases every lease already taken before it is raised; a release that also fails is said in the error.
    const stuck = (await releaseLeases(deps, leases)).filter((l) => !l.released).length;
    throw stuck ? new Error(`${(e as Error).message} (${stuck} lease(s) taken before the failure could not be released; they go stale after ${LEASE_STALE_SECONDS / 3600} hours)`) : e;
  }
  const planned = kinds.filter((k) => k.batches.length);
  return { ...head, drain: "on", ...(dry ? { dry: true as const } : {}), kinds, leases, totals: { kinds_planned: planned.length, batches: planned.reduce((a, k) => a + k.batches.length, 0), items: planned.reduce((a, k) => a + k.batches.reduce((b, x) => b + x.count, 0), 0), leases_held: leases.length } };
}

/** Release each lease and keep the answer: a release that throws is recorded on the lease, never lost and never raised (a stale lease is claimable anyway). */
async function releaseLeases(deps: Pick<DrainDeps, "release">, taken: readonly PlanLease[]): Promise<PlanLease[]> {
  const out: PlanLease[] = [];
  for (const l of taken) {
    let released = false;
    let release_error: string | null = null;
    try { released = await deps.release(l.lease_id, l.holder); } catch (e) { release_error = (e as Error).message; }
    out.push({ ...l, released, release_error });
  }
  return out;
}

/** Release every lease the plan took (a release that throws is recorded, never lost) and build the run body the harness records. */
export async function finishDrain(deps: Pick<DrainDeps, "release" | "now">, plan: DrainPlan, prs: Readonly<Record<string, string>> = {}) {
  const leases = await releaseLeases(deps, plan.leases);
  const done = { ...plan, leases };
  const perItem = done.kinds.flatMap((k) => k.batches.flatMap((b) => b.item_ids.map((id) => ({ id: `${k.kind}:${id}`, outcome: "planned", verdict: `batch ${b.batch_path}`, evidence_refs: [b.batch_path], error: null }))));
  const defects: Array<{ description: string; root_cause: string; fix_ref: null }> = [];
  for (const k of done.kinds) {
    if (k.export_error) defects.push({ description: `${k.kind}: export failed`, root_cause: k.export_error, fix_ref: null });
    for (const r of k.residue.lease_held) defects.push({ description: `${k.kind}: item ${r.id} left out (${r.reason})`, root_cause: r.holder ? `held by ${r.holder}` : "lease not taken", fix_ref: null });
  }
  for (const l of leases) if (!l.released) defects.push({ description: `lease on ${l.kind}:${l.id} not released`, root_cause: l.release_error ?? "release returned false (already released or taken over)", fix_ref: null });
  const releasedN = leases.filter((l) => l.released).length;
  return {
    plan: done,
    run: {
      config: { switch: done.switch, drain: done.drain, holder: done.holder, plan_run_id: done.run_id, kinds: done.kinds.map((k) => ({ kind: k.kind, mode: k.mode, pending_exported: k.pending_exported, planned: k.batches.reduce((a, b) => a + b.count, 0), batches: k.batches.map((b) => b.batch_path), apply_step: k.apply_step, pr: prs[k.kind] ?? null })), leases_held: leases.length, leases_released: releasedN, finished_at: deps.now().toISOString() },
      perItem,
      metrics: { kinds_planned: done.totals.kinds_planned, batches: done.totals.batches, items: done.totals.items, leases_held: leases.length, leases_released: releasedN, prs_opened: Object.keys(prs).length },
      defectsFound: defects,
    },
  };
}

/** Real lease deps over the service client's mutation-lease RPCs, and the switch read. */
export function leaseDeps(sb: Db): Pick<DrainDeps, "readSwitch" | "acquire" | "release"> {
  const one = <T>(d: T | T[] | null): T | null => (Array.isArray(d) ? (d[0] ?? null) : d);
  return {
    readSwitch: () => readDrainSwitch(sb),
    async acquire(id, holder, lane, stale) {
      const { data, error } = await sb.rpc("acquire_mutation_lease", { p_item: id, p_holder: holder, p_lane: lane, p_stale_seconds: stale });
      if (error) throw new Error(`acquire_mutation_lease failed (${id}): ${error.message}`);
      const r = one(data as { acquired: boolean; cur_holder: string | null } | { acquired: boolean; cur_holder: string | null }[] | null);
      return { acquired: !!r?.acquired, cur_holder: r?.cur_holder ?? null };
    },
    async release(id, holder) {
      const { data, error } = await sb.rpc("release_mutation_lease", { p_item: id, p_holder: holder });
      if (error) throw new Error(`release_mutation_lease failed (${id}): ${error.message}`);
      return !!one(data as { released: boolean } | { released: boolean }[] | null)?.released;
    },
  };
}

/**
 * The apply step of the `screen-verdict` kind: a session batch of `{census_id, verdict, basis, reviewer}` written into screen_verdicts (one row per census id, last ruling wins).
 * Every row is validated first; a bad row is refused by name and the rest still apply. The mint re-screens the reopened hold (P2-05); nothing here edits the census.
 */
export async function applyScreenVerdictBatch(deps: { sb: Db; now(): Date }, batch: { verdicts?: Array<Record<string, unknown>> }, opts: { dry?: boolean } = {}) {
  const rows: Array<{ census_id: string; verdict: string; basis: string; reviewer: string | null; ruled_at: string }> = [];
  const refused: string[] = [];
  for (const [i, v] of (batch.verdicts ?? []).entries()) {
    const basis = typeof v.basis === "string" ? v.basis.trim() : "";
    if (!UUID.test(String(v.census_id ?? ""))) refused.push(`verdicts[${i}]: census_id is not a uuid`);
    else if (!["on_vertical", "off_vertical", "ambiguous"].includes(String(v.verdict))) refused.push(`verdicts[${i}]: verdict "${v.verdict}" is not on_vertical, off_vertical or ambiguous`);
    else if (!basis) refused.push(`verdicts[${i}]: a ruling needs its basis (the citation)`);
    else rows.push({ census_id: String(v.census_id), verdict: String(v.verdict), basis, reviewer: typeof v.reviewer === "string" ? v.reviewer : null, ruled_at: deps.now().toISOString() });
  }
  if (opts.dry !== false || !rows.length) return { written: 0, planned: rows.length, refused };
  const { error } = await deps.sb.from("screen_verdicts").upsert(rows as never, { onConflict: "census_id" });
  if (error) throw new Error(`writing screen_verdicts failed: ${error.message}`);
  return { written: rows.length, planned: rows.length, refused };
}
