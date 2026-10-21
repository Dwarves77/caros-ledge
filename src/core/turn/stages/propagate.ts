// Ported from old_repo/scripts/turns/run-propagation-drain.mjs (lines 122-358)
// Ported from old_repo/scripts/turns/run-propagation-drain.mjs (lines 393-421)
// Stage 7, propagate: the producers (when asked), the outbox drain, the questions the drained changes raise, the signposts they fire, the re-scoring of the research assessments whose item changed, the impact scores of the items the connect stage read
// (and the backlog whose inputs changed since they were scored), and the carbon cost per FEU of every corridor with its four inputs (each a derived value, recomputed when an input changed).
// Everything after the drain works from the events the drain just processed, so one change reaches every consumer in the same run.
import type { FamilyCall } from "@/core/harness";
import { scoreItems } from "@/core/impact/run";
import { runPropagationDrain, reopener } from "@/core/propagation";
import { loadProducerRegistry, runProducer, runRegistered, selectRuns } from "@/core/producers";
import type { RunResult } from "@/core/types/run-result";
import { runResult, worst } from "@/core/types/run-result";
import { buildEntityItemsReader, buildSignpostStepDeps, runQuestionsOnChange, runSignpostStep } from "@/features/learning";
import { produceCarbonInputs } from "@/features/market/lib/carbon-run";
import { fetchLiveCandidates } from "@/features/research";

import type { BuiltDeps } from "../wiring";

const PROPAGATE_CALLER = "turn-propagate";
type DrainData = NonNullable<Awaited<ReturnType<typeof runPropagationDrain>>["data"]>;
type Processed = DrainData["processedEvents"][number];

export interface PropagatePlan {
  producers: { producer: string; only: string | undefined } | null;
  batch: number | undefined;
}
function planPropagate(input: Record<string, unknown>): PropagatePlan {
  const p = input.producers && typeof input.producers === "object" ? (input.producers as Record<string, unknown>) : input.producers === true ? {} : null;
  const only = typeof p?.only === "string" ? p.only : undefined;
  return { producers: p ? { producer: only ? "registry" : typeof p.producer === "string" ? p.producer : "all", only } : null, batch: typeof input.batch === "number" ? input.batch : undefined };
}

/** The ids of the items among the drained events: their research assessments are re-scored (IMP-055). Pure. */
const changedItemIds = (events: readonly Processed[]): string[] => [...new Set(events.filter((e) => e.tableName === "intelligence_items").map((e) => e.rowPk))];

const pick = (r: RunResult | null, prefix: string): Record<string, number> => Object.fromEntries(Object.entries(r?.counts ?? {}).map(([k, v]) => [`${prefix}${k}`, v]));

/** One result from the five steps. A producer the gates refused is a note, not a failed stage: the drain and its consumers still ran. Pure. */
export function shapePropagate(parts: { producers: RunResult | null; drain: RunResult; questions: RunResult; signposts: RunResult; assess: RunResult | null; impact?: RunResult<{ ids: { scored_item_ids: string[] } }> | null; carbon?: RunResult | null }, events: readonly Processed[], itemIds: readonly string[]): RunResult {
  const held = (r: RunResult) => (r.counts.refused ?? 0) > 0 || r.notes.some((n) => n.includes("REFUSING"));
  const soft = (r: RunResult | null) => (r && r.outcome === "failed" && held(r) ? { ...r, outcome: "partial" as const } : r);
  const producers = soft(parts.producers);
  const assess = soft(parts.assess);
  const counts: Record<string, number> = {
    drained: parts.drain.counts.drained ?? 0, recomputed: parts.drain.counts.recomputed ?? 0, invalidated: parts.drain.counts.invalidated ?? 0, events: parts.drain.counts.events ?? 0,
    questions_written: parts.questions.counts.written ?? 0, scored: parts.signposts.counts.scored ?? 0, signposts_fired: parts.signposts.counts.signposts_fired ?? 0, assessed_written: assess?.counts.written ?? 0,
    ...pick(producers, "producers_"), ...pick(assess, "assess_"), ...(parts.impact?.counts ?? {}), ...(parts.carbon?.counts ?? {}),
  };
  const outcome = worst(parts.drain.outcome, parts.questions.outcome, parts.signposts.outcome, producers?.outcome ?? "ok", assess?.outcome ?? "ok", parts.impact?.outcome ?? "ok", parts.carbon?.outcome ?? "ok");
  const notes = [parts.drain, parts.questions, parts.signposts, producers, assess, parts.impact ?? null, parts.carbon ?? null].flatMap((p) => p?.notes ?? []);
  return { ...runResult(outcome, counts, notes), data: { ids: { drained_event_ids: events.map((e) => String(e.eventId)), reassessed_item_ids: [...itemIds], scored_item_ids: parts.impact?.data?.ids.scored_item_ids ?? [] } } };
}

/** A producer run fetches its document, dry or not, so it runs only while the fetch gate is open (the analysis stages apply with the cadence off; fetching is what rule 16 holds); with the cadence off it is planned (selected and named), never fetched. */
async function runProducers(call: FamilyCall, d: BuiltDeps, p: NonNullable<PropagatePlan["producers"]>): Promise<RunResult> {
  if (await d.gate.refresh()) return runRegistered(d.producers, { catalog: d.catalog, producer: p.producer, only: p.only, mode: call.mode });
  try {
    const picked = selectRuns(loadProducerRegistry(d.catalog), { producer: p.producer, only: p.only });
    return runResult("ok", { selected: picked.length }, [`dry: ${picked.map((e) => e.name).join(", ") || "no producer"} planned, not fetched: the fetch gate is closed`]);
  } catch (e) {
    return runResult("failed", { selected: 0 }, [e instanceof Error ? e.message : String(e)]);
  }
}

export async function runPropagate(call: FamilyCall, d: BuiltDeps): Promise<RunResult> {
  const plan = planPropagate(call.input);
  const sb = d.sb;
  const producers = plan.producers ? await runProducers(call, d, plan.producers) : null;
  const drain = await runPropagationDrain({ sb, now: d.now, registry: d.registry, reopenQuestion: reopener(sb, d.learning) }, { dry: call.dry, caller: PROPAGATE_CALLER, ...(plan.batch ? { batch: plan.batch } : {}) });
  if (drain.outcome === "failed" && !drain.data?.eventsConsidered && drain.notes.length) return drain;
  const events = drain.data?.processedEvents ?? [];
  const questions = await runQuestionsOnChange({ sb, now: d.now, readEntityLinks: buildEntityItemsReader(sb) }, { dry: call.dry, events: events.map((e) => ({ eventId: e.eventId, tableName: e.tableName, rowPk: e.rowPk, entityId: e.entityId, changeKind: e.changeKind, occurredAt: e.occurredAt })) });
  const signposts = await runSignpostStep({ step: buildSignpostStepDeps(sb), now: d.now }, { dry: call.dry, events: events.map((e) => ({ eventId: String(e.eventId), tableName: e.tableName, entityId: e.entityId, changeKind: e.changeKind, occurredAt: e.occurredAt, newRow: e.newRow })) });
  const itemIds = changedItemIds(events);
  let assess: RunResult | null = null;
  if (itemIds.length) {
    const candidates = await fetchLiveCandidates(sb, undefined, { itemIds });
    if (candidates.length) assess = await runProducer(d.producers, { spec: d.assessment, dry: call.dry, text: JSON.stringify(candidates) });
  }
  const impact = await scoreItems({ sb, now: d.now, registry: d.registry }, { dry: call.dry, readIds: call.upstream?.ids.scanned_item_ids ?? [] });
  const carbon = await produceCarbonInputs({ sb, now: d.now, registry: d.registry }, { dry: call.dry });
  return shapePropagate({ producers, drain, questions, signposts, assess, impact, carbon }, events, itemIds);
}
