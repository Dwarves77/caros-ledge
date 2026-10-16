// Ported from old_repo/scripts/plan-quarantine-disposition.mjs (lines 24-139)
// Ported from old_repo/scripts/plan-quarantine-disposition.mjs (lines 144-186)
// Ported from old_repo/scripts/plan-quarantine-disposition.mjs (lines 212-232)
// Ported from old_repo/scripts/lib/quarantine-dwell.mjs (lines 1-69)
// Ported from old_repo/scripts/lib/deferral.mjs (lines 1-104)
// The quarantine disposition planner. A quarantined item may not sit undispositioned past the 14-day dwell bound (INV-054): it is either
// re-verified, or it carries a VALID deferral. Ruling 3: a deferral is capped at the dwell bound itself (the old 30-day window outlived the
// bound it was meant to answer), so `isValidDeferral` refuses a `deferred_until` more than 14 days out. The pure half (dwell, deferral
// validity, the candidate builder, the plan) is separate from the runtime half (`planQuarantine`: reads, the $0 re-verify pass, and, when
// applying, one CHECKED integrity_flags insert per candidate). Nothing waits on a human: the resolution events name machine events.
import { fetchAllRows, type Db } from "@/core/db";
import { runResult, type RunResult } from "@/core/intake/result";

import { HOLD_TYPES, resolveQuarantined } from "./resolver";

export const DWELL_BOUND_DAYS = 14;
export const DEFERRAL_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OWNER = "intake-session";
const MIN_REASON_LEN = 30;
const BAD_OWNERS = new Set(["tbd", "unknown", "n/a", "none", "owner tbd"]);
const PATH_KEYWORDS = ["reground", "re-ground", "relabel", "register", "archive", "counsel", "network", "primary source", "generate", "re-synthes"];

export interface Deferral { reason: string; deferred_until: string; owner: string; resolution_event: string }
export type DeferralVerdict = { ok: true } | { ok: false; error: string };
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Read and write validity of a deferral. The date must be in the future AND within the dwell bound from `now`. */
export function isValidDeferral(payload: unknown, now: Date): DeferralVerdict {
  if (!payload || typeof payload !== "object") return { ok: false, error: "deferral payload missing or not an object" };
  const { reason, deferred_until, owner, resolution_event } = payload as Record<string, unknown>;
  if (!text(reason)) return { ok: false, error: "deferral.reason is required (the blocker and the disposition path)" };
  if (reason.trim().length < MIN_REASON_LEN) return { ok: false, error: `deferral.reason too short (${reason.trim().length} < ${MIN_REASON_LEN})` };
  if (!PATH_KEYWORDS.some((k) => reason.toLowerCase().includes(k))) return { ok: false, error: `deferral.reason names no disposition path (one of: ${PATH_KEYWORDS.join(", ")})` };
  if (!text(resolution_event)) return { ok: false, error: "deferral.resolution_event is required (a named, checkable event that resolves the block)" };
  if (!text(deferred_until)) return { ok: false, error: "deferral.deferred_until is required (an ISO date string)" };
  const until = new Date(deferred_until).getTime();
  if (Number.isNaN(until)) return { ok: false, error: `deferral.deferred_until does not parse to a date: ${JSON.stringify(deferred_until)}` };
  if (until <= now.getTime()) return { ok: false, error: `deferral.deferred_until is not in the future (${deferred_until}): an expired deferral re-opens the item as undispositioned` };
  if (until > now.getTime() + DEFERRAL_WINDOW_DAYS * DAY_MS) return { ok: false, error: `deferral.deferred_until is beyond the ${DEFERRAL_WINDOW_DAYS}-day dwell bound (${deferred_until}): a deferral may not outlive the bound it answers (INV-054)` };
  if (!text(owner)) return { ok: false, error: "deferral.owner is required" };
  if (BAD_OWNERS.has(owner.trim().toLowerCase())) return { ok: false, error: `deferral.owner is a placeholder (${JSON.stringify(owner)})` };
  return { ok: true };
}

export interface QItem { id: string; legacy_id?: string | null; item_type?: string; title?: string | null }
export interface QFlag { subject_ref: string; created_at: string; created_by?: string | null; recommended_actions?: unknown }
export interface Dwell { enqueueMissing: QItem[]; undispositioned: (QItem & { ageDays: number; resurrected: boolean })[]; deferred: (QItem & { ageDays: number; deferral: Deferral })[]; withinBound: (QItem & { ageDays: number })[] }

/** The dwell clock is the earliest open flag per item. Past the bound with no valid, unexpired deferral is undispositioned (the hard tripwire). */
export function computeQuarantineDwell(a: { items: QItem[]; flags: QFlag[]; now: Date }): Dwell {
  const nowMs = a.now.getTime();
  const enqueuedAt = new Map<string, number>();
  for (const f of a.flags) {
    const t = new Date(f.created_at).getTime();
    const ex = enqueuedAt.get(f.subject_ref);
    if (ex === undefined || t < ex) enqueuedAt.set(f.subject_ref, t);
  }
  const valid = new Map<string, Deferral>();
  for (const f of a.flags) {
    if (f.created_by !== "disposition_deferred") continue;
    const ra = f.recommended_actions;
    let payload: unknown = null;
    if (Array.isArray(ra)) payload = (ra.find((e) => e && typeof e === "object" && "deferral" in e) as { deferral?: unknown } | undefined)?.deferral ?? ra[0];
    else if (ra && typeof ra === "object") payload = (ra as { deferral?: unknown }).deferral ?? ra;
    // The same strict check at read time: a deferral outside the bound (or expired, or vague) does not count (ruling 3, INV-054).
    const p = payload as Deferral | null;
    const read = isValidDeferral(p, a.now);
    if (read.ok && p) {
      const ex = valid.get(f.subject_ref);
      if (!ex || new Date(p.deferred_until).getTime() > new Date(ex.deferred_until).getTime()) valid.set(f.subject_ref, p);
    }
  }
  const ever = new Set(a.flags.filter((f) => f.created_by === "disposition_deferred").map((f) => f.subject_ref));
  const out: Dwell = { enqueueMissing: [], undispositioned: [], deferred: [], withinBound: [] };
  for (const it of a.items) {
    const at = enqueuedAt.get(it.id);
    if (at === undefined) {
      out.enqueueMissing.push(it);
      continue;
    }
    const ageDays = Math.floor((nowMs - at) / DAY_MS);
    if (nowMs - at > DWELL_BOUND_DAYS * DAY_MS) {
      const d = valid.get(it.id);
      if (d) out.deferred.push({ ...it, ageDays, deferral: d });
      else out.undispositioned.push({ ...it, ageDays, resurrected: ever.has(it.id) });
    } else out.withinBound.push({ ...it, ageDays });
  }
  return out;
}

const REASON_CLASS = {
  needs_acquire: { reason: "Needs-acquire: cheap verification found no usable stored capture to re-ground the item's FACT spans from; held pending a session-authored claim ledger through the injected-brief seam.", resolution_event: "a session-authored ledger is grounded for this item and validate_item_provenance passes" },
  stale_snapshot: { reason: "Stale-snapshot: the source appears to have changed since capture; held pending a re-ground against the current stored capture once a scrape time is set.", resolution_event: "the source is re-captured and a session-authored ledger is re-grounded against it" },
  held_type_q2_gate: { reason: "Held item_type (research_finding/technology/tool/innovation) is excluded from automated re-ground pending the Q2 calibration spec; held until that spec is ratified.", resolution_event: "the Q2 calibration spec is ratified and this item_type is unblocked for automated re-ground" },
  provenance_gate_insufficient: { reason: "Cheap-verify confirms the grounded spans still hold, but the item still fails the full provenance gate (floors or slots); held pending a manual re-ground or regenerate pass.", resolution_event: "a regeneration pass re-runs validate_item_provenance and the item passes" },
  verify_error: { reason: "The cheap-verify step errored for this item; held pending investigation of the failure before a re-ground attempt is retried.", resolution_event: "the verify error is diagnosed and a retried cheap-verify pass completes" },
} as const;
export type ReasonClass = keyof typeof REASON_CLASS;

/** One deferral candidate for a reason class; it must satisfy isValidDeferral (a programming error otherwise). */
export function buildDeferralCandidate(itemId: string, key: ReasonClass, now: Date): Deferral & { item_id: string; reason_class: ReasonClass } {
  const cls = REASON_CLASS[key];
  if (!cls) throw new Error(`unknown reason class '${key}'`);
  const payload: Deferral = { reason: cls.reason, deferred_until: new Date(now.getTime() + DEFERRAL_WINDOW_DAYS * DAY_MS - 1000).toISOString(), owner: DEFAULT_OWNER, resolution_event: cls.resolution_event };
  const v = isValidDeferral(payload, now);
  if (!v.ok) throw new Error(`reason class '${key}' built an invalid deferral: ${v.error}`);
  return { ...payload, item_id: itemId, reason_class: key };
}

export interface CheapDecision { outcome: string }
export interface PlanRow { item_id: string; legacy_id: string | null; disposition: "within_bound" | "already_deferred" | "enqueue_missing" | "deferral_candidate"; ageDays?: number; deferred_until?: string; reason_class?: ReasonClass; resurrected?: boolean; cheap_verify_outcome?: string | null }

/** Classify every live-quarantined item into a planned disposition. Pure. */
export function planDispositions(a: { items: QItem[]; flags: QFlag[]; cheapDecisionByItemId: ReadonlyMap<string, CheapDecision>; now: Date }) {
  const dwell = computeQuarantineDwell({ items: a.items, flags: a.flags, now: a.now });
  const byId = new Map(a.items.map((i) => [i.id, i]));
  const plan: PlanRow[] = [];
  const deferralCandidates: ReturnType<typeof buildDeferralCandidate>[] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string) => void (counts[k] = (counts[k] ?? 0) + 1);
  for (const it of dwell.withinBound) {
    plan.push({ item_id: it.id, legacy_id: it.legacy_id ?? null, disposition: "within_bound", ageDays: it.ageDays });
    bump("within_bound");
  }
  for (const it of dwell.deferred) {
    plan.push({ item_id: it.id, legacy_id: it.legacy_id ?? null, disposition: "already_deferred", ageDays: it.ageDays, deferred_until: it.deferral.deferred_until });
    bump("already_deferred");
  }
  for (const it of dwell.enqueueMissing) {
    plan.push({ item_id: it.id, legacy_id: it.legacy_id ?? null, disposition: "enqueue_missing" });
    bump("enqueue_missing");
  }
  for (const it of dwell.undispositioned) {
    const full = byId.get(it.id) ?? it;
    const d = a.cheapDecisionByItemId.get(it.id);
    const key: ReasonClass = HOLD_TYPES.has(full.item_type ?? "") ? "held_type_q2_gate" : !d || d.outcome === "needs-acquire" ? "needs_acquire" : d.outcome === "error" ? "verify_error" : d.outcome === "stale-snapshot" ? "stale_snapshot" : "provenance_gate_insufficient";
    deferralCandidates.push(buildDeferralCandidate(it.id, key, a.now));
    plan.push({ item_id: it.id, legacy_id: it.legacy_id ?? null, disposition: "deferral_candidate", reason_class: key, ageDays: it.ageDays, resurrected: it.resurrected, cheap_verify_outcome: d?.outcome ?? null });
    bump(`deferral_candidate:${key}`);
  }
  return { plan, counts, deferralCandidates };
}

export type PlanQuarantineResult = RunResult & { plan: PlanRow[]; deferralCandidates: ReturnType<typeof buildDeferralCandidate>[] };

/** Runtime entry: read the quarantined and their open flags, run the $0 re-verify pass, plan, and (apply) write the deferrals. Dry by default. */
export async function planQuarantine(deps: { sb: Db; now: () => Date }, input: { apply?: boolean } = {}): Promise<PlanQuarantineResult> {
  const { sb } = deps;
  const now = deps.now();
  const notes: string[] = [];
  let items: QItem[];
  let flags: QFlag[];
  try {
    items = await fetchAllRows<QItem>((from, to) => sb.from("intelligence_items").select("id, legacy_id, title, item_type").eq("is_archived", false).eq("provenance_status", "quarantined").order("id", { ascending: true }).range(from, to), { cap: 100_000 });
    flags = await fetchAllRows<QFlag>((from, to) => sb.from("integrity_flags").select("id, subject_ref, created_at, created_by, recommended_actions").eq("subject_type", "item").eq("status", "open").order("id", { ascending: true }).range(from, to), { cap: 200_000 });
  } catch (e) {
    return { ...runResult("failed", {}, [`planner read failed: ${e instanceof Error ? e.message : String(e)}`]), plan: [], deferralCandidates: [] };
  }
  const re = await resolveQuarantined(sb, {});
  notes.push(...re.notes);
  const decisions = new Map<string, CheapDecision>(re.decisions.map((d) => [d.itemId, { outcome: d.outcome }]));
  const { plan, counts, deferralCandidates } = planDispositions({ items, flags, cheapDecisionByItemId: decisions, now });
  let written = 0;
  let failed = 0;
  if (input.apply) {
    for (const c of deferralCandidates) {
      const { item_id, reason_class, ...deferral } = c;
      const ins = await sb.from("integrity_flags").insert({ category: "data_quality", subject_type: "item", subject_ref: item_id, created_by: "disposition_deferred", status: "open", description: `Quarantine disposition (${reason_class}): ${deferral.reason}`.slice(0, 480), recommended_actions: [{ action: "defer", rationale: deferral.reason, deferral }] });
      if (ins.error) {
        failed += 1;
        notes.push(`deferral for ${item_id} NOT written: ${ins.error.message}`);
      } else written += 1;
    }
  }
  return { ...runResult(failed || re.outcome !== "ok" ? "partial" : "ok", { live_quarantined: items.length, open_flags: flags.length, ...counts, deferral_candidates: deferralCandidates.length, deferrals_written: written, deferrals_failed: failed }, notes), plan, deferralCandidates };
}
