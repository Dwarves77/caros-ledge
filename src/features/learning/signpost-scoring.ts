// Ported from old_repo/src/lib/learning/prediction-scoring.mjs (lines 1-343)
// A signpost is a prediction scored when its watched entity changes or its expectation date passes (ADR-044 decision 4). The first qualifying outbox event, in occurrence
// order, fires it ONCE (never on a signposts-table event, never on an event at or after its deadline); the outcome is the direction map (confirms held, refutes refuted,
// delays partial); a deadline passed with no firing scores refuted; scoring writes one source_reliability_ledger row per distinct grounding source BEFORE the score, and
// the ledger is evidence only, it never writes a tier (INV-246). Firing is one database call that moves the assessment lifecycle in the same transaction.
import { evaluateSignpostPredicate } from "@/core/propagation";
import type { SignpostPredicate } from "@/core/propagation/signpost";
import { runResult, type RunResult } from "@/core/intake/result";

export const OUTCOME_BY_DIRECTION: Readonly<Record<string, "held" | "refuted" | "partial">> = Object.freeze({ confirms: "held", refutes: "refuted", delays: "partial" });
export const SCORED_BY = "signpost_watch@1";
const DAY_MS = 86_400_000;

export interface OutboxEvent { eventId: string; tableName: string; entityId: string | null; changeKind?: string | null; occurredAt: string; newRow?: Record<string, unknown> | null }
export interface SignpostRow { entity_id: string; assessment_id: string; watches: string; predicate: SignpostPredicate & { by?: string }; direction: string; fired_at: string | null; outcome?: string | null; lifecycle_applied_at?: string | null }
export interface LedgerRow { source_id: string; signpost_entity_id: string; outcome: string; scored_at: string; scored_by: string; assessment_id: string }

/** What the step reads and writes (signpost-scoring-deps.ts supplies the real ones over the service client; a missing column is a schema-step failure, not a branch). */
export interface SignpostStepDeps {
  readSignpostsWatching(entityIds: string[]): Promise<SignpostRow[]>;
  readFiredUnscored(): Promise<SignpostRow[]>;
  readDeadlineCandidates(): Promise<SignpostRow[]>;
  readLifecycleUnapplied(): Promise<SignpostRow[]>;
  readAssessments(ids: string[]): Promise<Map<string, { item_id: string | null; lifecycle_state: string }>>;
  readGroundingSources(itemIds: string[]): Promise<Map<string, string[]>>;
  readLedgerSources(signpostEntityId: string): Promise<string[]>;
  fire(signpostEntityId: string, now: Date, reason: string): Promise<void>;
  writeLedger(rows: LedgerRow[]): Promise<void>;
  scoreSignpost(entityId: string, patch: { outcome: string; outcome_assessed_at: string; scored_by: string }): Promise<void>;
}

export const outcomeForDirection = (d: string): "held" | "refuted" | "partial" | null => OUTCOME_BY_DIRECTION[d] ?? null;
/** The predicate's `by` as a deadline in ms; a bare date is the END of that day. Null when absent or unparseable. */
export function deadlineMs(predicate: { by?: unknown } | null | undefined): number | null {
  const by = predicate && typeof predicate === "object" ? predicate.by : null;
  if (typeof by !== "string" || !by) return null;
  const t = new Date(by).getTime();
  return Number.isNaN(t) ? null : /^\d{4}-\d{2}-\d{2}$/.test(by) ? t + DAY_MS : t;
}
export const isDeadlinePassed = (predicate: { by?: unknown }, now: Date): boolean => {
  const d = deadlineMs(predicate);
  return d !== null && d <= now.getTime();
};
export const scorePatch = (outcome: string, now: Date) => ({ outcome, outcome_assessed_at: now.toISOString(), scored_by: SCORED_BY });
/** One ledger row per DISTINCT grounding source. */
export function buildLedgerRows(o: { signpostEntityId: string; assessmentId: string; outcome: string; sourceIds: readonly string[] | null | undefined; now: Date }): LedgerRow[] {
  return [...new Set((o.sourceIds ?? []).filter(Boolean))].map((source_id) => ({ source_id, signpost_entity_id: o.signpostEntityId, outcome: o.outcome, scored_at: o.now.toISOString(), scored_by: SCORED_BY, assessment_id: o.assessmentId }));
}
export const watchedRowForEvent = (e: OutboxEvent): Record<string, unknown> => ({ ...(e.newRow && typeof e.newRow === "object" ? e.newRow : {}), occurred_at: e.occurredAt, change_kind: e.changeKind ?? null, table_name: e.tableName });

/** Match events to the unfired signposts watching their entity, in occurrence order (then id); each signpost fires on the first qualifying event only. */
export function matchEventsToSignposts(events: readonly OutboxEvent[], signposts: readonly SignpostRow[], now: Date) {
  const out = { fires: [] as Array<{ signpost: SignpostRow; event: OutboxEvent; reason: string }>, evaluated: 0, late: 0, signpostOriginEvents: 0, eventsNoEntity: 0, eventsMatched: 0 };
  const byEntity = new Map<string, SignpostRow[]>();
  for (const sp of signposts) if (!sp.fired_at) byEntity.set(sp.watches, [...(byEntity.get(sp.watches) ?? []), sp]);
  const fired = new Set<string>();
  const matched = new Set<string>();
  for (const ev of [...events].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime() || Number(a.eventId) - Number(b.eventId))) {
    if (ev.tableName === "signposts") { out.signpostOriginEvents += 1; continue; }
    if (!ev.entityId) { out.eventsNoEntity += 1; continue; }
    for (const sp of byEntity.get(ev.entityId) ?? []) {
      if (fired.has(sp.entity_id)) continue;
      matched.add(ev.eventId);
      const d = deadlineMs(sp.predicate);
      if (d !== null && new Date(ev.occurredAt).getTime() >= d) { out.late += 1; continue; }
      out.evaluated += 1;
      const v = evaluateSignpostPredicate(sp.predicate, watchedRowForEvent(ev), now);
      if (v.fired) {
        fired.add(sp.entity_id);
        out.fires.push({ signpost: sp, event: ev, reason: v.reason });
      }
    }
  }
  out.eventsMatched = matched.size;
  return out;
}

export interface SignpostStepResult extends RunResult { failedEventIds: string[]; scored: Array<{ signpost: string; outcome: string; via: string; sources: number }> }
const COUNTS = ["events_seen", "events_matched", "events_no_entity", "events_signpost_origin", "events_late", "signposts_evaluated", "signposts_fired", "scored", "scored_held", "scored_refuted", "scored_partial", "scored_by_event", "scored_by_repair", "scored_by_deadline", "ledger_rows_planned", "ledger_rows_written", "ledger_rows_existing", "scored_without_sources", "lifecycle_repair_planned", "lifecycle_repaired", "errors"] as const;

/**
 * One pass: fire on events, repair (score a fired-unscored signpost, apply a lifecycle that was never applied), score the deadline-passed, and score ledger-first. Dry counts
 * everything and writes nothing. A failure on one signpost is counted and its event id returned so the caller can replay it; it never aborts the pass.
 */
export async function runSignpostStep(deps: { step: SignpostStepDeps; now(): Date }, input: { dry?: boolean; events: readonly OutboxEvent[]; sweep?: boolean }): Promise<SignpostStepResult> {
  const apply = input.dry === false;
  const now = deps.now();
  const s = deps.step;
  const c = Object.fromEntries(COUNTS.map((k) => [k, 0])) as Record<(typeof COUNTS)[number], number>;
  const notes: string[] = [];
  const failed = new Set<string>();
  const scoredList: SignpostStepResult["scored"] = [];
  const err = (what: string, e: unknown) => { c.errors += 1; notes.push(`${what}: ${e instanceof Error ? e.message : String(e)}`); };
  const events = input.events;
  c.events_seen = events.length;
  const entityIds = [...new Set(events.filter((e) => e.tableName !== "signposts" && e.entityId).map((e) => e.entityId as string))];
  const m = matchEventsToSignposts(events, entityIds.length ? await s.readSignpostsWatching(entityIds) : [], now);
  Object.assign(c, { events_matched: m.eventsMatched, events_no_entity: m.eventsNoEntity, events_signpost_origin: m.signpostOriginEvents, events_late: m.late, signposts_evaluated: m.evaluated, signposts_fired: m.fires.length });
  const toScore: Array<{ sp: SignpostRow; outcome: string; via: "event" | "repair" | "deadline"; eventId: string | null }> = [];
  const firedNow = new Set<string>();
  for (const f of m.fires) {
    if (apply) {
      try { await s.fire(f.signpost.entity_id, now, f.reason); } catch (e) { err(`fire ${f.signpost.entity_id}`, e); failed.add(f.event.eventId); continue; }
    }
    firedNow.add(f.signpost.entity_id);
    const outcome = outcomeForDirection(f.signpost.direction);
    if (outcome) toScore.push({ sp: f.signpost, outcome, via: "event", eventId: f.event.eventId });
  }
  if (input.sweep !== false) {
    for (const sp of await s.readFiredUnscored()) {
      const outcome = outcomeForDirection(sp.direction);
      if (!firedNow.has(sp.entity_id) && outcome) toScore.push({ sp, outcome, via: "repair", eventId: null });
    }
    // A signpost fired but whose assessment lifecycle was never applied: firing again is idempotent on the stamp and moves the lifecycle by the table.
    for (const sp of (await s.readLifecycleUnapplied()).filter((x) => !firedNow.has(x.entity_id))) {
      c.lifecycle_repair_planned += 1;
      if (!apply) continue;
      try { await s.fire(sp.entity_id, now, "lifecycle repair"); c.lifecycle_repaired += 1; } catch (e) { err(`lifecycle ${sp.entity_id}`, e); }
    }
    for (const sp of await s.readDeadlineCandidates()) if (!sp.fired_at && !firedNow.has(sp.entity_id) && isDeadlinePassed(sp.predicate, now)) toScore.push({ sp, outcome: "refuted", via: "deadline", eventId: null });
  }
  if (toScore.length) {
    const assessments = await s.readAssessments([...new Set(toScore.map((t) => t.sp.assessment_id))]);
    const itemIds = [...new Set([...assessments.values()].map((a) => a.item_id).filter((x): x is string => !!x))];
    const grounding = itemIds.length ? await s.readGroundingSources(itemIds) : new Map<string, string[]>();
    for (const t of toScore) {
      const itemId = assessments.get(t.sp.assessment_id)?.item_id ?? null;
      const rows = buildLedgerRows({ signpostEntityId: t.sp.entity_id, assessmentId: t.sp.assessment_id, outcome: t.outcome, sourceIds: itemId ? (grounding.get(itemId) ?? []) : [], now });
      c.scored += 1;
      c[`scored_${t.outcome}` as "scored_held"] += 1;
      c[`scored_by_${t.via}` as "scored_by_event"] += 1;
      if (!rows.length) c.scored_without_sources += 1;
      c.ledger_rows_planned += rows.length;
      scoredList.push({ signpost: t.sp.entity_id, outcome: t.outcome, via: t.via, sources: rows.length });
      if (!apply) continue;
      try {
        if (rows.length) {
          const have = new Set(await s.readLedgerSources(t.sp.entity_id));
          const fresh = rows.filter((r) => !have.has(r.source_id));
          c.ledger_rows_existing += rows.length - fresh.length;
          if (fresh.length) await s.writeLedger(fresh);
          c.ledger_rows_written += fresh.length;
        }
        await s.scoreSignpost(t.sp.entity_id, scorePatch(t.outcome, now));
      } catch (e) { err(`score ${t.sp.entity_id}`, e); if (t.eventId != null) failed.add(t.eventId); }
    }
  }
  return { ...runResult(c.errors ? "partial" : "ok", c, notes), failedEventIds: [...failed], scored: scoredList };
}

/** Counts under a prefix for a caller's own run counts. */
export const signpostMetrics = (r: RunResult | null | undefined, prefix = "sp_"): Record<string, number> => Object.fromEntries(Object.entries(r?.counts ?? {}).map(([k, v]) => [`${prefix}${k}`, v]));
