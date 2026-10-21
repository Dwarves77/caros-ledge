// New in CARBON-1 (scripts/ci/new-files/carbon-1.txt): the reader of the carbon cost per FEU. The propagate stage records the current state of each input and of the cost in carbon_inputs (migration 0120): a pointer to a derived value, or the sentence saying
// why there is none. This reads both, the values through derived_values_admissible (a stale or superseded value is not in it, so a pointer to one reads as "recomputing", never as a figure), and returns them by scope and input for the Market page.
import type { Db } from "@/core/db";
import { fetchAllRows, rowsByIds } from "@/core/db";
import { CARBON } from "@/core/propagation/carbon-rules";
import type { Admissibility, InputRef, Lifecycle } from "@/core/propagation/types";

export type CarbonInputName = "price" | "distance" | "payload" | "intensity" | "cost";

export interface CarbonValue {
  valueId: string;
  value: number;
  unit: string | null;
  currency: string | null;
  admissibility: Admissibility;
  lifecycle: Lifecycle;
  derivation: string;
  originClass: string;
  methodVersion: string;
  /** What the value was computed from (the lineage the stage compares before it writes a new one). */
  inputs: InputRef[];
}
/** One input (or the cost): the value it holds or the reason it holds none (`valueId` is the live value the scope holds, `pointer` the value the row points at, which a recompute may have replaced), with the basis it rests on, the rating of its published source (null for a value computed from code data) and the method that wrote it. */
export type CarbonState = { valueId: string | null; pointer: string | null; basis: string; sourceTier: number | null; methodVersion: string; computedAt: string } & ({ value: CarbonValue; reason: null } | { value: null; reason: string });
/** scope -> input -> state. A corridor's scope is its entity id; the price and the payload are 'market'; an intensity is 'mode:<mode>'. */
export type CarbonStore = Record<string, Partial<Record<CarbonInputName, CarbonState>>>;

interface PointerRow {
  scope: string;
  input: CarbonInputName;
  value_id: string | null;
  absent_reason: string | null;
  basis: string;
  source_tier: number | null;
  method_version: string;
  computed_at: string;
}
interface ValueRow {
  value_id: string;
  supersedes: string | null;
  method_version: string;
  value: number | string | null;
  unit: string | null;
  currency: string | null;
  derivation: string;
  origin_class: string;
  lifecycle: Lifecycle;
  admissibility: Admissibility;
  inputs: InputRef[] | null;
}

const VALUE_COLUMNS = "value_id, supersedes, method_version, value, unit, currency, derivation, origin_class, lifecycle, admissibility, inputs";
/** Every recorded state, with its current value: the value the row points at while it is live, else the live value that replaced it (the drain recomputes a value an input change staled and registers its successor). A failed read throws: a page never draws an empty store for a failed one. */
export async function readCarbonInputs(db: Db): Promise<CarbonStore> {
  const pointers = await fetchAllRows<PointerRow>((from, to) => db.from("carbon_inputs").select("scope, input, value_id, absent_reason, basis, source_tier, method_version, computed_at").order("scope", { ascending: true }).order("input", { ascending: true }).range(from, to), { cap: 100_000 });
  const pointed = pointers.flatMap((p) => (p.value_id ? [p.value_id] : []));
  const values = new Map((await rowsByIds<ValueRow>(db, "derived_values_admissible", VALUE_COLUMNS, pointed, "value_id", "value_id")).map((v) => [v.value_id, v]));
  const replaced = (await rowsByIds<ValueRow>(db, "derived_values_admissible", VALUE_COLUMNS, pointed.filter((id) => !values.has(id)), "supersedes", "value_id")).flatMap((v) => (v.supersedes ? [[v.supersedes, v] as const] : []));
  const successors = new Map(replaced);
  const store: CarbonStore = {};
  for (const p of pointers) {
    const v = p.value_id ? (values.get(p.value_id) ?? successors.get(p.value_id)) : undefined;
    const head = { valueId: v?.value_id ?? null, pointer: p.value_id, basis: p.basis, sourceTier: p.source_tier, methodVersion: p.method_version, computedAt: p.computed_at };
    const state: CarbonState = v && Number.isFinite(Number(v.value))
      ? { ...head, reason: null, value: { valueId: v.value_id, value: Number(v.value), unit: v.unit, currency: v.currency, admissibility: v.admissibility, lifecycle: v.lifecycle, derivation: v.derivation, originClass: v.origin_class, methodVersion: v.method_version, inputs: v.inputs ?? [] } }
      : { ...head, value: null, reason: p.absent_reason ?? CARBON.absence.pending };
    (store[p.scope] ??= {})[p.input] = state;
  }
  return store;
}
