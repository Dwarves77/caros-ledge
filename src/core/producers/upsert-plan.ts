// Ported from old_repo/scripts/producers/operations/ukpn-capacity-heatmap-producer.mjs (lines 177-198)
// Ported from old_repo/scripts/producers/oem/eea-hdv-co2-producer.mjs (lines 59-80)
// Ported from old_repo/src/lib/market/write-market-series.mjs (lines 20-67)
// Ported from old_repo/src/lib/regional/regional-facts-envelope.mjs (lines 88-125)
// ONE keyed upsert planner for the four key shapes (series+period, region+dimension+label, dso+substation+as_of, manufacturer+tech+source).
export type Rec = Record<string, unknown>;

export interface UpsertPlan<R extends Rec, E extends Rec> {
  toCreate: R[];
  toUpdate: Array<{ pk: unknown; patch: Partial<R>; existing: E }>;
  unchanged: number;
  /** Incoming rows whose key is null (for example a market row with no reference_period): never written. */
  skipped: R[];
}

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a == null || b == null) return a == null && b == null;
  return typeof a === "number" || typeof b === "number" ? Number(a) === Number(b) : JSON.stringify(a) === JSON.stringify(b);
};

/**
 * Create what is new, patch only the `patchable` fields that differ, count the rest unchanged. `key` returns null for a row that must not be written.
 * An existing row with a null key is ignored (it can never match), and a duplicate incoming key is created once.
 */
export function planKeyedUpsert<R extends Rec, E extends Rec>(existing: readonly E[], incoming: readonly R[], opts: { key: (row: R | E) => string | null; patchable: readonly string[]; pk: string }): UpsertPlan<R, E> {
  const byKey = new Map<string, E>();
  for (const e of existing) {
    const k = opts.key(e);
    if (k !== null) byKey.set(k, e);
  }
  const plan: UpsertPlan<R, E> = { toCreate: [], toUpdate: [], unchanged: 0, skipped: [] };
  const seen = new Set<string>();
  for (const row of incoming) {
    const k = opts.key(row);
    if (k === null) {
      plan.skipped.push(row);
      continue;
    }
    const have = byKey.get(k);
    if (!have) {
      if (!seen.has(k)) plan.toCreate.push(row);
      seen.add(k);
      continue;
    }
    const patch: Partial<R> = {};
    for (const f of opts.patchable) if (!sameValue(have[f], row[f])) (patch as Rec)[f] = row[f] ?? null;
    if (Object.keys(patch).length === 0) plan.unchanged += 1;
    else plan.toUpdate.push({ pk: have[opts.pk], patch, existing: have });
  }
  return plan;
}

/** The four key shapes as named key builders. A part that is null or empty makes the whole key null where the part is required. */
export const keyOf = (parts: unknown[], required: number = parts.length): string | null => {
  for (let i = 0; i < required; i += 1) if (parts[i] === null || parts[i] === undefined || parts[i] === "") return null;
  return parts.map((p) => String(p ?? "")).join("\u0000");
};
export const KEYS = {
  seriesPeriod: (r: Rec) => keyOf([r.series_key, r.reference_period]),
  regionDimensionLabel: (r: Rec) => keyOf([r.region_code ?? r.region_id, r.dimension, r.fact_label]),
  dsoSubstationAsOf: (r: Rec) => keyOf([r.dso_name, r.substation_ref, r.as_of], 3),
  manufacturerTechSource: (r: Rec) => keyOf([r.manufacturer_id, r.tech_category, r.source_id]),
};
