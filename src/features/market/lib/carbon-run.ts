// New in CARBON-1 (scripts/ci/new-files/carbon-1.txt): the propagate stage's carbon step. For every corridor it settles the four inputs of the carbon cost per FEU and the cost: each is computed by its registered method from what the store holds (the latest allowance
// observation, the two ports' positions, the latest payload default, the modal-default factor of the corridor's mode), compared with the value the corridor points at now, and written as a new derived value (superseding the old) only when its value, its ceiling or what
// it was computed from changed. An input that cannot be computed is recorded with the sentence that says why and names the missing input, in the slot of the figure, and the cost then says which inputs it waits for: a gap is stated where the value goes, never removed.
// Dry computes the same states and writes nothing.
import type { Db } from "@/core/db";
import { boundedRead, rowsByIds } from "@/core/db";
import { readCarbonInputs, type CarbonInputName, type CarbonStore } from "@/core/derived/carbon";
import { corridorScopes, portPosition } from "@/core/entities";
import { CARBON, inSentence } from "@/core/propagation/carbon-rules";
import { CARBON_METHOD_ID, CARBON_METHOD_VERSION, COST_METHOD_ID, COST_METHOD_VERSION, DISTANCE_METHOD_ID, DISTANCE_METHOD_VERSION, PAYLOAD_METHOD_ID, PAYLOAD_METHOD_VERSION, PRICE_METHOD_ID, PRICE_METHOD_VERSION, type MethodRegistry, type ResolvedMethodInput } from "@/core/propagation/methods";
import { registerDerivedValue } from "@/core/propagation/register";
import type { InputRef } from "@/core/propagation/types";
import { hostOf } from "@/core/shared";
import { classTierForHost } from "@/core/sources";
import type { RunResult } from "@/core/types/run-result";

import { selectFactor, type FactorRow } from "./carbon";

interface SeriesRow {
  id: string;
  series_key: string;
  source_key: string | null;
}
const FACTOR_COLS = "factor_id, mode, vehicle_class, jurisdiction, quantity_basis, ttw_co2e, wtt_co2e, wtw_co2e, source_key, tier, derivation, origin_class, method_version, n_observations, as_at_date, pedigree";
const SERIES_COLS = "id, series_key, value_numeric, unit, currency, derivation, origin_class, source_key, as_at_date, reference_period";

/** What one settle works from: the rows the method reads, the lineage to record, the rating of the source, what was searched (the basis of an absence) and, when there is nothing to compute from, the sentence saying so. */
interface Step {
  inputs: ResolvedMethodInput[];
  refs: InputRef[];
  tier: number | null;
  searched: string;
  none?: string;
}
type Settled = { ok: true; valueId: string; row: Record<string, unknown> } | { ok: false; reason: string };
interface Run {
  sb: Db;
  registry: MethodRegistry;
  now: Date;
  dry: boolean;
  store: CarbonStore;
  counts: Record<string, number>;
}
const sameLineage = (a: readonly InputRef[], b: readonly InputRef[]): boolean => JSON.stringify(a.map((r) => `${r.table}/${r.pk}`).sort()) === JSON.stringify(b.map((r) => `${r.table}/${r.pk}`).sort());
const failure = (what: string, error: { message: string } | null): void => {
  if (error) throw new Error(`${what} failed: ${error.message}`);
};

const bump = (r: Run, key: string): void => void (r.counts[key] = (r.counts[key] ?? 0) + 1);

/** Settle one input of one scope: compute it, compare it with the state the scope holds, write what changed. */
async function settle(r: Run, scope: string, input: CarbonInputName, method: { id: string; version: string }, step: Step, entity: string | null = null): Promise<Settled> {
  const fn = r.registry.get("derived_values", method.id, method.version);
  if (!fn) throw new Error(`the registry holds no ${method.id}@${method.version}`);
  const held = r.store[scope]?.[input];
  const out = step.none ? ({ ok: false, reason: step.none } as const) : await fn({ entityId: entity, inputs: step.inputs, priorValue: held?.value ?? null, now: r.now });
  const methodVersion = `${method.id}@${method.version}`;
  const basis = out.ok ? (out.basis ?? step.searched) : step.searched;
  const tier = out.ok ? step.tier : null;
  const reason = out.ok ? null : out.reason;
  const v = held?.value;
  const reuse = out.ok && v && v.value === out.value && v.admissibility === out.admissibility && v.methodVersion === method.version && sameLineage(v.inputs, step.refs) ? v.valueId : null;
  let valueId = reuse;
  if (out.ok && !reuse) {
    bump(r, "carbon_values_written");
    valueId = r.dry ? `dry:${scope}/${input}` : await registerDerivedValue(r.sb, {
      entityId: entity, methodId: method.id, methodVersion: method.version, value: out.value ?? null, unit: out.unit ?? null, currency: out.currency ?? null, derivation: out.derivation, originClass: out.originClass, lifecycle: out.lifecycle,
      admissibility: out.admissibility, confidence: out.confidence, assertedAt: r.now.toISOString(), halfLifeDays: out.halfLifeDays ?? null, inputs: step.refs, computedBy: `${methodVersion}:propagate`, supersedes: held?.valueId ?? held?.pointer ?? null,
    });
  }
  if (!out.ok) bump(r, "carbon_absent");
  if (!(held && held.pointer === valueId && held.reason === reason && held.basis === basis && held.sourceTier === tier && held.methodVersion === methodVersion)) {
    bump(r, "carbon_states_written");
    if (!r.dry) {
      // The value the scope pointed at stands no longer: the new one (or the absence) replaces it, and nothing reads the old as current.
      for (const old of new Set([held?.valueId, held?.pointer])) if (old && old !== valueId) failure("derived_values supersede", (await r.sb.from("derived_values").update({ lifecycle: "superseded" }).eq("value_id", old)).error);
      failure("carbon_inputs upsert", (await r.sb.from("carbon_inputs").upsert({ scope, input, value_id: valueId, absent_reason: reason, basis, source_tier: tier, method_version: methodVersion, computed_at: r.now.toISOString() }, { onConflict: "scope,input" })).error);
    }
  }
  if (!out.ok || !valueId) return { ok: false, reason: reason ?? "" };
  return { ok: true, valueId, row: { method_id: method.id, value: out.value, unit: out.unit ?? null, currency: out.currency ?? null, admissibility: out.admissibility, base_confidence: out.confidence } };
}

/** The rating of a data source: the class tier of its publisher's host (the same table the Market page rates a series with); null when the source is unknown or its host is unplaced. */
async function tierOf(sb: Db, sourceKey: string | null): Promise<number | null> {
  if (!sourceKey) return null;
  const [src] = await rowsByIds<{ source_key: string; name: string; url: string | null }>(sb, "data_sources", "source_key, name, url", [sourceKey], "source_key", "source_key");
  return src?.url ? classTierForHost(hostOf(src.url), src.name) : null;
}

/** The latest observation of a series prefix as a step: the one row, rated, or the sentence that none was captured. */
async function latestObservation(sb: Db, prefix: string, none: string): Promise<Step> {
  const read = await boundedRead<SeriesRow>((n) => sb.from("market_series").select(SERIES_COLS).like("series_key", `${prefix}:%`).order("reference_period", { ascending: false }).order("id", { ascending: true }).limit(n) as never, { limit: 1 });
  if (read.error) throw new Error(`market_series read failed: ${read.error.message}`);
  const row = read.data[0];
  const searched = `latest observation of the ${prefix} series`;
  if (!row) return { inputs: [], refs: [], tier: null, searched, none };
  const tier = await tierOf(sb, row.source_key);
  return { inputs: [{ table: "market_series", pk: row.id, row: { ...row, source_tier: tier } }], refs: [{ table: "market_series", pk: row.id }], tier, searched };
}

export async function produceCarbonInputs(deps: { sb: Db; now: () => Date; registry: MethodRegistry }, input: { dry: boolean }): Promise<RunResult> {
  const { sb } = deps;
  const run: Run = { sb, registry: deps.registry, now: deps.now(), dry: input.dry, store: await readCarbonInputs(sb), counts: { carbon_corridors: 0, carbon_values_written: 0, carbon_states_written: 0, carbon_absent: 0, carbon_cost_figures: 0 } };
  const corridors = (await corridorScopes(sb)).flatMap((c) => (c.parsed ? [{ id: c.entityId, ...c.parsed }] : []));
  run.counts.carbon_corridors = corridors.length;
  const factors = corridors.length ? await boundedRead<FactorRow>((n) => sb.from("emission_factors").select(FACTOR_COLS).eq("tier", "modal_default").is("superseded_by", null).order("factor_id", { ascending: true }).limit(n) as never, { limit: 200 }) : null;
  if (factors?.error) throw new Error(`emission_factors read failed: ${factors.error.message}`);
  const price = await settle(run, "market", "price", { id: PRICE_METHOD_ID, version: PRICE_METHOD_VERSION }, await latestObservation(sb, CARBON.price.seriesPrefix, CARBON.absence.price));
  const payload = await settle(run, "market", "payload", { id: PAYLOAD_METHOD_ID, version: PAYLOAD_METHOD_VERSION }, await latestObservation(sb, CARBON.payload.seriesPrefix, CARBON.absence.payload));
  const intensity = new Map<string, Settled>();
  for (const mode of new Set(corridors.map((c) => c.mode))) {
    const picked = selectFactor(factors?.data ?? [], { mode });
    const step: Step = picked.state === "resolved"
      ? { inputs: [{ table: "emission_factors", pk: String(picked.factor.factor_id), row: picked.factor }], refs: [{ table: "emission_factors", pk: String(picked.factor.factor_id) }], tier: await tierOf(sb, picked.factor.source_key ?? null), searched: `the ${mode} modal-default factor` }
      : { inputs: [], refs: [], tier: null, searched: `the ${mode} modal-default factor`, none: (picked.state === "no_factor" && (factors?.data ?? []).filter((f) => f.mode?.toLowerCase() === mode.toLowerCase()).length > 1 ? CARBON.absence.intensityMany : CARBON.absence.intensity).replace("{mode}", mode) };
    intensity.set(mode, await settle(run, `mode:${mode}`, "intensity", { id: CARBON_METHOD_ID, version: CARBON_METHOD_VERSION }, step));
  }
  for (const c of corridors) {
    const distance = await settle(run, c.id, "distance", { id: DISTANCE_METHOD_ID, version: DISTANCE_METHOD_VERSION }, { inputs: [c.origin, c.dest].map((code) => ({ table: "ports", pk: code, row: portPosition(code) })), refs: [], tier: null, searched: CARBON.distance.basis }, c.id);
    const parts: [CarbonInputName, Settled][] = [["price", price], ["distance", distance], ["payload", payload], ["intensity", intensity.get(c.mode) as Settled]];
    const made = parts.flatMap(([, s]) => (s.ok ? [s] : []));
    const absent = parts.flatMap(([name, s]) => (s.ok ? [] : [`${inSentence(CARBON.labels[name])} (${s.reason})`]));
    for (const [name, s] of parts) if (!s.ok) bump(run, `carbon_missing_${name}`);
    const step: Step = made.length === parts.length
      ? { inputs: made.map((s) => ({ table: "derived_values", pk: s.valueId, row: s.row })), refs: made.map((s) => ({ table: "derived_values", pk: s.valueId })), tier: null, searched: CARBON.cost.basis }
      : { inputs: [], refs: [], tier: null, searched: CARBON.cost.basis, none: CARBON.absence.cost.replace("{inputs}", absent.join(", ")) };
    if ((await settle(run, c.id, "cost", { id: COST_METHOD_ID, version: COST_METHOD_VERSION }, step, c.id)).ok) bump(run, "carbon_cost_figures");
  }
  return { counts: run.counts, outcome: "ok", notes: input.dry ? ["dry: nothing written"] : [] };
}
