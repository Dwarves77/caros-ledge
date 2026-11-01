// Ported from old_repo/scripts/turns/run-propagation-drain.mjs (lines 122-358)
// Ported from old_repo/scripts/turns/run-propagation-drain.mjs (lines 393-421)
// Stage 7, propagate: the producers (when asked), the outbox drain, the questions the drained changes raise, the signposts they fire, the re-scoring of the research assessments whose item changed, the impact scores of the items the connect stage read
// (and the backlog whose inputs changed since they were scored), and the carbon cost per FEU of every corridor with its four inputs (each a derived value, recomputed when an input changed).
// Everything after the drain works from the events the drain just processed, so one change reaches every consumer in the same run.
import { readFileSync } from "node:fs";

import { COLUMNS, mineRefs } from "@/core/coupling";
import { FAMILIES, type FamilyCall } from "@/core/harness";
import { scoreItems } from "@/core/impact/run";
import { runPropagationDrain, reopener } from "@/core/propagation";
import { citedPages, loadProducerRegistry, runProducer, runRegistered, selectRuns } from "@/core/producers";
import type { RunResult } from "@/core/types/run-result";
import { leadWithFailures, runResult, worst } from "@/core/types/run-result";
import { buildEntityItemsReader, buildSignpostStepDeps, runQuestionsOnChange, runSignpostStep } from "@/features/learning";
import { produceCarbonInputs } from "@/features/market/lib/carbon-run";
import { cursorAfter, FILL_ONLY, fillObjectFields } from "@/features/obligations";
import { fetchLiveCandidates } from "@/features/research";

import type { BuiltDeps } from "../wiring";

import { captureCited } from "./capture";

const PROPAGATE_CALLER = "turn-propagate";
/** The typed tables the producers write in this stage (ENGINE-ORDER-1): their rows are filed in entity_refs before the turn ends. The item-owned tables (an item's obligations and forward events) are filed by the connect stage, which reads the items. */
const ITEM_OWNED = new Set(["obligation_objects", "item_forward_events"]);
const PRODUCER_TABLES = COLUMNS.map((m) => m.table).filter((t) => !ITEM_OWNED.has(t));
type DrainData = NonNullable<Awaited<ReturnType<typeof runPropagationDrain>>["data"]>;
type Processed = DrainData["processedEvents"][number];

/** A reviewed rows file is read only from the producers' own data/rows directories. */
const ROWS_FILE = /^src\/features\/(?:market|operations|statutory)\/producers\/data\/rows\/[\w.-]+\.(?:json|csv)$/;
export interface PropagatePlan {
  producers: { producer: string; only: string | undefined; rowsFile: string | undefined; orgId: string | undefined; since: string | undefined } | null;
  batch: number | undefined;
  /** DERIVE-2: fill the null mode, statutory maximum and cost formula of a bounded batch of obligation objects from their verbatim spans; absent, nothing is derived. */
  derive: { only: string; batch: number | undefined } | null;
  /** The operator ruling that carries ONE run past the closed fetch gate (rule 16 stays: nothing in system_state changes); empty when none. */
  exception: string;
}
function planPropagate(input: Record<string, unknown>): PropagatePlan {
  const p = input.producers && typeof input.producers === "object" ? (input.producers as Record<string, unknown>) : input.producers === true ? {} : null;
  const only = typeof p?.only === "string" ? p.only : undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const dv = input.derive && typeof input.derive === "object" ? (input.derive as Record<string, unknown>) : null;
  return { derive: dv ? { only: str(dv.only) ?? FILL_ONLY, batch: typeof dv.batch === "number" ? dv.batch : undefined } : null, producers: p ? { producer: only ? "registry" : str(p.producer) ?? "all", only, rowsFile: str(p.rowsFile), orgId: str(p.orgId), since: str(p.since) } : null, batch: typeof input.batch === "number" ? input.batch : undefined, exception: str(input.cadence_exception)?.trim() ?? "" };
}

/** The ids of the items among the drained events: their research assessments are re-scored (IMP-055). Pure. */
const changedItemIds = (events: readonly Processed[]): string[] => [...new Set(events.filter((e) => e.tableName === "intelligence_items").map((e) => e.rowPk))];

const pick = (r: RunResult | null, prefix: string): Record<string, number> => Object.fromEntries(Object.entries(r?.counts ?? {}).map(([k, v]) => [`${prefix}${k}`, v]));

/** One result from the five steps. A producer the gates refused is a note, not a failed stage: the drain and its consumers still ran. Pure. */
export function shapePropagate(parts: { producers: RunResult | null; drain: RunResult; questions: RunResult; signposts: RunResult; assess: RunResult | null; derive?: RunResult<{ ids: { derive_cursor: string[] } }> | null; impact?: RunResult<{ ids: { scored_item_ids: string[] } }> | null; carbon?: RunResult | null; mined?: RunResult | null }, events: readonly Processed[], itemIds: readonly string[]): RunResult {
  const held = (r: RunResult) => (r.counts.refused ?? 0) > 0 || r.notes.some((n) => n.includes("REFUSING"));
  const soft = (r: RunResult | null) => (r && r.outcome === "failed" && held(r) ? { ...r, outcome: "partial" as const } : r);
  const producers = soft(parts.producers);
  const assess = soft(parts.assess);
  const counts: Record<string, number> = {
    drained: parts.drain.counts.drained ?? 0, recomputed: parts.drain.counts.recomputed ?? 0, invalidated: parts.drain.counts.invalidated ?? 0, events: parts.drain.counts.events ?? 0,
    questions_written: parts.questions.counts.written ?? 0, scored: parts.signposts.counts.scored ?? 0, signposts_fired: parts.signposts.counts.signposts_fired ?? 0, assessed_written: assess?.counts.written ?? 0,
    ...pick(producers, "producers_"), ...pick(assess, "assess_"), ...pick(parts.derive ?? null, "derive_"), ...(parts.impact?.counts ?? {}), ...(parts.carbon?.counts ?? {}), refs_written: parts.mined?.counts.refs_written ?? 0,
  };
  const outcome = worst(parts.drain.outcome, parts.questions.outcome, parts.signposts.outcome, producers?.outcome ?? "ok", assess?.outcome ?? "ok", parts.impact?.outcome ?? "ok", parts.carbon?.outcome ?? "ok", parts.derive?.outcome ?? "ok", parts.mined?.outcome ?? "ok");
  const notes = leadWithFailures([parts.derive ?? null, parts.drain, parts.questions, parts.signposts, producers, assess, parts.impact ?? null, parts.carbon ?? null, parts.mined ?? null]);
  return { ...runResult(outcome, counts, notes), data: { ids: { drained_event_ids: events.map((e) => String(e.eventId)), reassessed_item_ids: [...itemIds], scored_item_ids: parts.impact?.data?.ids.scored_item_ids ?? [], ...(parts.derive?.data ? { derive_cursor: parts.derive.data.ids.derive_cursor } : {}) } } };
}

/** A producer run fetches its document, dry or not, so it runs only while the fetch gate is open (the analysis stages apply with the cadence off; fetching is what rule 16 holds); with the cadence off it is planned (selected and named), never fetched. A named ruling opens the gate for an APPLY call only; a dry call records it and fetches nothing. */
async function runProducers(call: FamilyCall, d: BuiltDeps, p: NonNullable<PropagatePlan["producers"]>, exception: string): Promise<RunResult> {
  const ruled = !call.dry && exception !== "";
  const covered = (): string => { try { return selectRuns(loadProducerRegistry(d.catalog), { producer: p.producer, only: p.only }).map((e) => e.name).join(", "); } catch { return p.only ?? p.producer; } };
  const ruling = exception ? [`cadence exception ${ruled ? "in force for this call only" : "recorded (dry: nothing fetched)"}: "${exception}"; producers covered: ${covered()}`] : [];
  // a producer that reads stored data only (spec.fetches === false) needs no open fetch gate: rule 16 holds fetching, not reading
  const stored = (): boolean => { try { return selectRuns(loadProducerRegistry(d.catalog), { producer: p.producer, only: p.only }).every((e) => d.catalog[e.name]?.fetches === false); } catch { return false; } };
  if ((await d.gate.refresh()) || ruled || stored()) {
    if (p.rowsFile && !ROWS_FILE.test(p.rowsFile)) return runResult("failed", { refused: 1 }, [`refused: rowsFile "${p.rowsFile}" is not a file under a producer's data/rows directory`]);
    const text = p.rowsFile ? readFileSync(p.rowsFile, "utf8") : undefined;
    const cited = text !== undefined && !call.dry ? await captureCited(d, citedPages(text), ruled) : null;
    const r = await runRegistered(d.producers, { catalog: d.catalog, producer: p.producer, only: p.only, mode: call.mode, ...(p.since ? { since: p.since } : {}), ...(text !== undefined ? { input: { text, ...(p.orgId ? { orgId: p.orgId } : {}) } } : {}) });
    return { ...r, counts: { ...r.counts, ...(cited ? pick(cited, "capture_") : {}), ...(ruled ? { cadence_exception: 1 } : {}) }, notes: r.outcome === "failed" ? [...r.notes, ...ruling, ...(cited?.notes ?? [])] : [...ruling, ...(cited?.notes ?? []), ...r.notes] };
  }
  try {
    const picked = selectRuns(loadProducerRegistry(d.catalog), { producer: p.producer, only: p.only });
    return runResult("ok", { selected: picked.length }, [`dry: ${picked.map((e) => e.name).join(", ") || "no producer"} planned, not fetched: the fetch gate is closed`, ...ruling]);
  } catch (e) {
    return runResult("failed", { selected: 0 }, [e instanceof Error ? e.message : String(e)]);
  }
}

/** DERIVE-2: one bounded batch of obligation objects after the cursor the last apply turn left in its ledger row (dry rows never advance it). Runs before the drain, so the changes it writes are drained in the same run. */
async function runDerive(call: FamilyCall, d: BuiltDeps, p: NonNullable<PropagatePlan["derive"]>): Promise<RunResult<{ ids: { derive_cursor: string[] } }>> {
  const failed = (note: string) => ({ counts: {}, outcome: "failed" as const, notes: [note] });
  if (p.only !== FILL_ONLY) return failed(`derive: only "${p.only}" is not a derivation (the one is "${FILL_ONLY}")`);
  const family = FAMILIES.find((f) => f.stage === "propagate")?.name ?? "";
  const { data, error } = await d.sb.from("harness_runs").select("outputs").eq("family", family).eq("mode", "apply").order("started_at", { ascending: false }).limit(20);
  if (error) return failed(`derive: harness_runs read failed: ${error.message}`);
  const last = (data ?? []).map((r) => (r.outputs as { ids?: { derive_cursor?: string[] } } | null)?.ids?.derive_cursor).find((c) => c !== undefined);
  return fillObjectFields(d.sb, { dry: call.dry, ...(p.batch ? { batch: p.batch } : {}), after: cursorAfter(last) });
}

export async function runPropagate(call: FamilyCall, d: BuiltDeps): Promise<RunResult> {
  const plan = planPropagate(call.input);
  const sb = d.sb;
  const producers = plan.producers ? await runProducers(call, d, plan.producers, plan.exception) : null;
  const derive = plan.derive ? await runDerive(call, d, plan.derive) : null;
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
  // every typed row the producers wrote above is filed under its entities now, not by the next turn's connect stage
  const mined = await mineRefs({ sb, now: d.now }, { dry: call.dry, tables: PRODUCER_TABLES });
  return shapePropagate({ producers, derive, drain, questions, signposts, assess, impact, carbon, mined }, events, itemIds);
}
