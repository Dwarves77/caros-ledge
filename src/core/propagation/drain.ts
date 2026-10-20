// Ported from old_repo/src/lib/propagation/drain.ts (lines 1-420)
// The governed drain (spec 08 section 2): read a batch of undrained outbox events, Pass 1 invalidates the dependents of each (in both modes), an
// APPLY run then marks the event drained, and Pass 2 recomputes every stale derived value AND stale inference through the registered method,
// registering a superseding row (the stale one is retained, never overwritten). A dry run writes nothing and stops after Pass 1. A value whose
// method is unregistered or refuses stays stale. Events addressed to intelligence_items and section_claim_provenance (a correction) are ordinary
// events: their payload (the correction row) rides in `newRow`. One recompute loop serves both tables.
import type { Db } from "@/core/db";
import { exactCount } from "@/core/db";
import type { RunResult } from "@/core/sources/run-result";

import { METHODS, type MethodRegistry, type ResolvedMethodInput } from "./methods";
import { registerDerivedValue, registerInferenceRecord } from "./register";
import type { InputRef } from "./types";

export interface DrainDeps {
  sb: Db;
  now: () => Date;
  registry?: MethodRegistry;
  /** The learning slice: re-open the question an inference answered, after the inference was recomputed (ADR-044). */
  reopenQuestion?: (subjectRef: string) => Promise<{ reopened: boolean; reason: string }>;
}
export interface DrainInput {
  dry: boolean;
  caller: string;
  batch?: number;
}
export interface ProcessedEvent {
  eventId: number | string;
  tableName: string;
  rowPk: string;
  entityId: string | null;
  changeKind: string | null;
  occurredAt: string;
  newRow: Record<string, unknown> | null;
}
export interface DrainDetail {
  mode: "dry" | "apply";
  queueDepthBefore: number;
  eventsConsidered: number;
  eventsDrained: number;
  invalidated: number;
  recomputed: number;
  skippedUnknownMethod: number;
  skippedMethodRefused: number;
  superseded: { from: string; to: string }[];
  errors: { eventId: number | string; message: string }[];
  processedEvents: ProcessedEvent[];
  questionsReopened: number;
}
const DEFAULT_BATCH = 500;

/** The primary-key column per input table (a table not listed resolves to a null row, which a method refuses on). */
const PK_COLUMN: Readonly<Record<string, string>> = {
  emission_factors: "factor_id", market_series: "id", regional_data_facts: "id", derived_values: "value_id", statutory_computations: "computation_id",
  estimated_values: "estimate_id", state_cost_facts: "id", inference_records: "inference_id", intelligence_items: "id", section_claim_provenance: "id",
};

/** Resolve declared inputs to their current rows. A MISSING row is a null row; a failed READ throws (it is never read as missing). */
export async function resolveInputs(sb: Db, inputs: readonly InputRef[]): Promise<ResolvedMethodInput[]> {
  const out: ResolvedMethodInput[] = [];
  for (const ref of inputs) {
    const col = PK_COLUMN[ref.table];
    if (!col) {
      out.push({ table: ref.table, pk: ref.pk, version: ref.version ?? null, row: null });
      continue;
    }
    const { data, error } = await sb.from(ref.table).select("*").eq(col, ref.pk).maybeSingle();
    if (error) throw new Error(`resolve input ${ref.table}/${ref.pk}: ${error.message}`);
    out.push({ table: ref.table, pk: ref.pk, version: ref.version ?? null, row: data ?? null });
  }
  return out;
}

/** The declared inputs of an inference: its derivation_edges rows. A failed read throws. */
async function resolveInferenceDeclaredInputs(sb: Db, inferenceId: string): Promise<InputRef[]> {
  const { data, error } = await sb.from("derivation_edges").select("from_table,from_pk").eq("to_table", "inference_records").eq("to_value_id", inferenceId);
  if (error) throw new Error(`derivation_edges read failed for inference ${inferenceId}: ${error.message}`);
  return ((data ?? []) as { from_table: string; from_pk: string }[]).map((e) => ({ table: e.from_table, pk: e.from_pk, version: null }));
}

type StaleDerived = { value_id: string; entity_id: string | null; method_id: string; method_version: string; inputs: InputRef[] | null; unit: string | null; currency: string | null };
type StaleInference = { inference_id: string; subject_id: string | null; claim_text: string; cited_item_ids: string[]; trigger_question_ref: string | null; method_id: string; method_version: string };

export async function runPropagationDrain(deps: DrainDeps, input: DrainInput): Promise<RunResult<DrainDetail>> {
  const { sb } = deps;
  const apply = !input.dry;
  const registry = deps.registry ?? METHODS;
  const batch = input.batch ?? DEFAULT_BATCH;
  const detail: DrainDetail = { mode: apply ? "apply" : "dry", queueDepthBefore: 0, eventsConsidered: 0, eventsDrained: 0, invalidated: 0, recomputed: 0, skippedUnknownMethod: 0, skippedMethodRefused: 0, superseded: [], errors: [], processedEvents: [], questionsReopened: 0 };
  const finish = (): RunResult<DrainDetail> => ({
    counts: { queue_depth_before: detail.queueDepthBefore, events: detail.eventsConsidered, drained: detail.eventsDrained, invalidated: detail.invalidated, recomputed: detail.recomputed, skipped_unknown_method: detail.skippedUnknownMethod, skipped_method_refused: detail.skippedMethodRefused, questions_reopened: detail.questionsReopened, errors: detail.errors.length },
    outcome: detail.errors.length === 0 ? "ok" : detail.eventsConsidered > 0 && detail.errors.length >= detail.eventsConsidered && detail.recomputed === 0 ? "failed" : "partial",
    notes: detail.errors.slice(0, 20).map((e) => `event ${e.eventId}: ${e.message}`),
    data: detail,
  });

  try {
    detail.queueDepthBefore = await exactCount(sb.from("propagation_events").select("event_id", { count: "exact", head: true }).is("drained_at", null));
  } catch (e) {
    detail.errors.push({ eventId: "n/a", message: e instanceof Error ? e.message : String(e) });
    return finish();
  }
  const evRes = await sb.from("propagation_events").select("event_id,table_name,row_pk,entity_id,change_kind,occurred_at,new_row").is("drained_at", null).order("occurred_at", { ascending: true }).limit(batch);
  if (evRes.error) {
    detail.errors.push({ eventId: "n/a", message: `reading propagation_events failed: ${evRes.error.message}` });
    return finish();
  }
  const events = (evRes.data ?? []) as { event_id: number | string; table_name: string; row_pk: string; entity_id: string | null; change_kind?: string | null; occurred_at: string; new_row?: Record<string, unknown> | null }[];
  detail.eventsConsidered = events.length;
  if (!events.length) return finish();
  const drainRunId = `${input.caller}:${deps.now().toISOString()}`;

  for (const ev of events) {
    const inv = await sb.rpc("invalidate_dependents", { p_table: ev.table_name, p_pk: ev.row_pk, p_event: ev.event_id, p_apply: apply });
    if (inv.error) {
      detail.errors.push({ eventId: ev.event_id, message: `invalidate_dependents: ${inv.error.message}` });
      continue;
    }
    detail.invalidated += typeof inv.data === "number" ? inv.data : 0;
    if (apply) {
      const mark = await sb.from("propagation_events").update({ drained_at: deps.now().toISOString(), drain_run_id: drainRunId }).eq("event_id", ev.event_id);
      if (mark.error) {
        detail.errors.push({ eventId: ev.event_id, message: `mark drained: ${mark.error.message}` });
        continue;
      }
      detail.eventsDrained += 1;
    }
    detail.processedEvents.push({ eventId: ev.event_id, tableName: ev.table_name, rowPk: ev.row_pk, entityId: ev.entity_id ?? null, changeKind: ev.change_kind ?? null, occurredAt: ev.occurred_at, newRow: ev.new_row ?? null });
  }
  if (!apply) return finish();

  const eventIds = events.map((e) => e.event_id);
  await recomputeStale<StaleDerived>(deps, detail, {
    table: "derived_values",
    select: "value_id,entity_id,method_id,method_version,inputs,unit,currency",
    idOf: (r) => r.value_id,
    eventIds,
    async recompute(row) {
      const fn = registry.get("derived_values", row.method_id, row.method_version);
      if (!fn) return { kind: "unknown" };
      const out = await fn({ entityId: row.entity_id, inputs: await resolveInputs(sb, row.inputs ?? []), priorValue: row, now: deps.now() });
      if (!out.ok) return { kind: "refused" };
      const to = await registerDerivedValue(sb, {
        entityId: row.entity_id, methodId: row.method_id, methodVersion: row.method_version, value: out.value ?? null, valueLow: out.valueLow ?? null, valueHigh: out.valueHigh ?? null,
        unit: out.unit ?? row.unit ?? null, currency: out.currency ?? row.currency ?? null, derivation: out.derivation, originClass: out.originClass, lifecycle: out.lifecycle,
        admissibility: out.admissibility, confidence: out.confidence, assertedAt: deps.now().toISOString(), halfLifeDays: out.halfLifeDays ?? null, inputs: row.inputs ?? [],
        computedBy: `${row.method_id}@${row.method_version}`, supersedes: row.value_id,
      });
      return { kind: "done", to };
    },
  });
  await recomputeStale<StaleInference>(deps, detail, {
    table: "inference_records",
    select: "inference_id,subject_id,claim_text,cited_item_ids,trigger_question_ref,method_id,method_version",
    idOf: (r) => r.inference_id,
    eventIds,
    async recompute(row) {
      const fn = registry.get("inference_records", row.method_id, row.method_version);
      if (!fn) return { kind: "unknown" };
      const declared = await resolveInferenceDeclaredInputs(sb, row.inference_id);
      const out = await fn({ entityId: row.subject_id, inputs: await resolveInputs(sb, declared), priorValue: { inference_id: row.inference_id, claim_text: row.claim_text, cited_item_ids: row.cited_item_ids, trigger_question_ref: row.trigger_question_ref }, now: deps.now() });
      if (!out.ok) return { kind: "refused" };
      const to = await registerInferenceRecord(sb, {
        subjectId: row.subject_id, claimText: out.claimText, statusToken: out.statusToken, confidence: out.confidence, citedItemIds: out.citedItemIds, originClass: out.originClass,
        methodId: row.method_id, methodVersion: row.method_version, computedBy: `${row.method_id}@${row.method_version}`, triggerQuestionRef: row.trigger_question_ref, inputs: declared, supersedes: row.inference_id,
      });
      return { kind: "done", to, reopen: out.reopenQuestionRef ?? null };
    },
  });
  return finish();
}

type Outcome = { kind: "unknown" } | { kind: "refused" } | { kind: "done"; to: string; reopen?: string | null };
interface Spec<R> {
  table: string;
  select: string;
  eventIds: (number | string)[];
  idOf(row: R): string;
  recompute(row: R): Promise<Outcome>;
}

/** The one recompute loop: stale rows invalidated by this batch, each through its method, each superseded by a new row. */
async function recomputeStale<R>(deps: DrainDeps, detail: DrainDetail, spec: Spec<R>): Promise<void> {
  const { data, error } = await deps.sb.from(spec.table).select(spec.select).eq("admissibility", "stale").in("invalidated_by_event", spec.eventIds);
  if (error) {
    detail.errors.push({ eventId: "n/a", message: `reading stale ${spec.table} failed: ${error.message}` });
    return;
  }
  for (const row of (data ?? []) as unknown as R[]) {
    const id = spec.idOf(row);
    try {
      const o = await spec.recompute(row);
      if (o.kind === "unknown") detail.skippedUnknownMethod += 1;
      else if (o.kind === "refused") detail.skippedMethodRefused += 1;
      else {
        detail.recomputed += 1;
        detail.superseded.push({ from: id, to: o.to });
        if (o.reopen && deps.reopenQuestion) {
          try {
            if ((await deps.reopenQuestion(o.reopen)).reopened) detail.questionsReopened += 1;
          } catch (e) {
            detail.errors.push({ eventId: "n/a", message: `re-opening question ${o.reopen} after recomputing ${id} failed: ${e instanceof Error ? e.message : String(e)}` });
          }
        }
      }
    } catch (e) {
      detail.errors.push({ eventId: "n/a", message: `recompute ${spec.table} ${id} failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
}
