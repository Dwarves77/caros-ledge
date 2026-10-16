// Ported from old_repo/scripts/propagation/seed-derived-values.mjs (lines 13-94)
// Seed one carbon_intensity_tkm derived value per licence-clear emission factor, each with its edge to the factor. A factor whose source may not be
// re-served is counted, never seeded; a factor the method refuses is counted. A runtime function (dry flag, no CLI); the method is the market slice's.
import type { Db } from "@/core/db";
import { mayEmbedAsSeed } from "@/core/contracts";
import { fetchAllRows } from "@/core/db";
import { confidenceFromPedigree, lifecycleFromFactorOriginClass, registerDerivedValue, type MarketMethodDeps } from "@/core/propagation";
import type { RunResult } from "@/core/sources/run-result";

export const CARBON_METHOD_ID = "carbon_intensity_tkm";
export const CARBON_METHOD_VERSION = "1.0.0";

interface FactorRow {
  factor_id: string;
  quantity_basis: unknown;
  ttw_co2e: unknown;
  wtw_co2e: unknown;
  wtt_co2e: unknown;
  source_key: string;
  origin_class: string | null;
  pedigree: number | null;
}

export async function seedDerivedValues(deps: { sb: Db; now: () => Date; carbonIntensity: MarketMethodDeps["carbonIntensity"] }, input: { dry: boolean }): Promise<RunResult> {
  const rows = await fetchAllRows<FactorRow>((from, to) => deps.sb.from("emission_factors").select("factor_id,quantity_basis,ttw_co2e,wtw_co2e,wtt_co2e,source_key,origin_class,pedigree").order("factor_id", { ascending: true }).range(from, to), { cap: 200_000 });
  const counts: Record<string, number> = { total: rows.length, licence_blocked: 0, refused: 0, would_create: 0, created: 0, failed: 0 };
  const notes: string[] = [];
  for (const factor of rows) {
    if (!mayEmbedAsSeed(factor.source_key)) {
      counts.licence_blocked = (counts.licence_blocked ?? 0) + 1;
      continue;
    }
    const r = deps.carbonIntensity(factor as unknown as Parameters<MarketMethodDeps["carbonIntensity"]>[0]);
    if (!r.ok) {
      counts.refused = (counts.refused ?? 0) + 1;
      continue;
    }
    counts.would_create = (counts.would_create ?? 0) + 1;
    if (input.dry) continue;
    try {
      await registerDerivedValue(deps.sb, {
        entityId: null,
        methodId: CARBON_METHOD_ID,
        methodVersion: CARBON_METHOD_VERSION,
        value: r.valueGPerUnit,
        unit: r.unit,
        derivation: "calculated",
        originClass: "derived",
        lifecycle: lifecycleFromFactorOriginClass(factor.origin_class),
        admissibility: "calculation_ok",
        confidence: confidenceFromPedigree(factor.pedigree),
        assertedAt: deps.now(),
        halfLifeDays: null,
        inputs: [{ table: "emission_factors", pk: factor.factor_id }],
        computedBy: `${CARBON_METHOD_ID}@${CARBON_METHOD_VERSION}:seed-derived-values`,
      });
      counts.created = (counts.created ?? 0) + 1;
    } catch (e) {
      counts.failed = (counts.failed ?? 0) + 1;
      notes.push(`emission_factors ${factor.factor_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const failed = counts.failed ?? 0;
  return { counts, outcome: failed === 0 ? "ok" : (counts.created ?? 0) > 0 ? "partial" : "failed", notes: input.dry ? [...notes, "dry: nothing written"] : notes };
}
