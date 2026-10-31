// New file (scripts/ci/new-files/impact-1.txt): the impact score as a pure method (registered as impact_scores@1.0.0 in src/core/propagation/methods.ts, INV-202). It reads what the item holds, applies the thresholds of data/rules.json
// and returns three dimensions (cost, compliance, operational), each 0 to 3 with its basis, or NULL with the input it is waiting for. The fourth dimension (client) is workspace-relative and computed at read time (read.ts), never stored.
// A dimension is NULL exactly when its input is absent AND the item's source text has not been read yet (`examined` false); an item that was read and states nothing scores 0. NULL is never a 0.
import { RULES, type ImpactInputName } from "./rules";

export interface ImpactObject {
  obligation_id: string;
  binding_position: string | null;
  duty_holder_class: readonly string[] | null;
  entry_into_force: string | null;
  date_of_application: string | null;
  first_deadline: string | null;
  sanction_class: string | null;
  statutory_maximum: string | null;
  direct_compliance_cost: unknown;
}
export interface ImpactInput {
  /** The run date, YYYY-MM-DD (the method reads no clock). */
  today: string;
  /** The item's source text has been read for its duties (item_obligation_scan has its row). */
  examined: boolean;
  /** The item's CURRENT obligation objects. */
  objects: readonly ImpactObject[];
  /** The ids of the statutory computations written for those obligations. */
  computations: readonly string[];
  item: { transport_modes: readonly string[]; operational_scenario_tags: readonly string[]; cost_mechanism: string | null; penalty_range: string | null; severity: string | null };
  /** The customer tier of the item's source and the authority floor of its type (the largest tier number that still counts), null when unknown or exempt. */
  sourceTier: number | null;
  floorTier: number | null;
  /** The org roles each duty-holder class maps to (the vocabulary). */
  holderRoles: Readonly<Record<string, readonly string[]>>;
}
export interface ImpactScore {
  cost: number | null;
  compliance: number | null;
  operational: number | null;
  basis: { compliance: Record<string, unknown>; cost: Record<string, unknown>; operational: Record<string, unknown> };
  missing: ImpactInputName[];
}

const filled = (s: unknown): boolean => typeof s === "string" && s.trim() !== "";
const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dateOf = (o: ImpactObject, field: string): string | null => {
  const v = (o as unknown as Record<string, unknown>)[field];
  return typeof v === "string" && v !== "" ? v : null;
};
const onOrBefore = (o: ImpactObject, fields: readonly string[], day: string): boolean => fields.some((f) => {
  const d = dateOf(o, f);
  return d !== null && d <= day;
});

/** Compliance: 0 the source states no duty, 1 every duty is non-binding, 2 a binding duty with no date inside the horizon, 3 a binding duty in force or due inside it. NULL: the source has not been read. */
function compliance(i: ImpactInput): { value: number | null; basis: Record<string, unknown> } {
  const ids = i.objects.map((o) => o.obligation_id);
  if (!i.objects.length) return { value: i.examined ? 0 : null, basis: { obligations: ids, examined: i.examined } };
  const binding = i.objects.filter((o) => !RULES.nonBinding.includes(o.binding_position ?? ""));
  const horizon = addDays(i.today, RULES.horizonDays);
  const due = binding.filter((o) => onOrBefore(o, RULES.inForceFields, i.today) || onOrBefore(o, RULES.dueFields, horizon));
  return { value: !binding.length ? 1 : due.length ? 3 : 2, basis: { obligations: ids, binding: binding.map((o) => o.obligation_id), due: due.map((o) => o.obligation_id), horizon } };
}

/** Cost: 1 a mechanism or a sanction class with no figure, 2 a figure from a source below the type's floor, 3 a figure from a source at or above it, 0 nothing in a source that was read. */
function cost(i: ImpactInput): { value: number | null; basis: Record<string, unknown> } {
  const figures = [
    ...i.objects.filter((o) => o.direct_compliance_cost != null).map((o) => `obligation_objects.direct_compliance_cost:${o.obligation_id}`),
    ...i.objects.filter((o) => filled(o.statutory_maximum)).map((o) => `obligation_objects.statutory_maximum:${o.obligation_id}`),
    ...(filled(i.item.penalty_range) ? ["intelligence_items.penalty_range"] : []),
    ...i.computations.map((c) => `statutory_computations:${c}`),
  ];
  const signals = [...(filled(i.item.cost_mechanism) ? ["intelligence_items.cost_mechanism"] : []), ...i.objects.filter((o) => filled(o.sanction_class)).map((o) => `obligation_objects.sanction_class:${o.obligation_id}`)];
  const meetsFloor = i.sourceTier !== null && (i.floorTier === null || i.sourceTier <= i.floorTier);
  const value = figures.length ? (meetsFloor ? 3 : 2) : signals.length ? 1 : i.examined ? 0 : null;
  return { value, basis: { figures, signals, sourceTier: i.sourceTier, floorTier: i.floorTier } };
}

/** Operational: the modes and scenario tags counted together (1, 2, 3 or more), 3 also when a duty names a forwarder or a carrier; 0 none in a source that was read. */
function operational(i: ImpactInput): { value: number | null; basis: Record<string, unknown> } {
  const signals = [...new Set([...i.item.transport_modes, ...i.item.operational_scenario_tags])];
  const holders = i.objects.filter((o) => (o.duty_holder_class ?? []).some((c) => (i.holderRoles[c] ?? []).some((r) => RULES.operationalRoles.includes(r)))).map((o) => o.obligation_id);
  const value = holders.length ? 3 : signals.length ? Math.min(signals.length, RULES.operationalSignalsForThree) : i.examined ? 0 : null;
  return { value, basis: { modes: [...i.item.transport_modes], tags: [...i.item.operational_scenario_tags], holders } };
}

/** The cost dimension with the item's typed severity: a cost-alert severity is a cost signal (1) where the figures and mechanisms name none, so an alert the brief states is never scored 0 or left waiting. */
function costWithSeverity(i: ImpactInput): { value: number | null; basis: Record<string, unknown> } {
  const k = cost(i);
  return RULES.costSeverities.includes(i.item.severity ?? "") && !k.value ? { value: 1, basis: { ...k.basis, signals: ["intelligence_items.severity"] } } : k;
}

/** The three stored dimensions of an item. Pure: the same input gives the same score, so a rules edit is a new method version. */
export function scoreImpact(input: ImpactInput): ImpactScore {
  const [c, k, o] = [compliance(input), costWithSeverity(input), operational(input)];
  const missing: ImpactInputName[] = [c.value === null ? "obligations" : null, k.value === null ? "cost" : null, o.value === null ? "operational" : null].filter((m): m is ImpactInputName => m !== null);
  return { compliance: c.value, cost: k.value, operational: o.value, basis: { compliance: c.basis, cost: k.basis, operational: o.basis }, missing };
}
