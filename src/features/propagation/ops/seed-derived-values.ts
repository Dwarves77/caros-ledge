// Ported from old_repo/scripts/propagation/seed-derived-values.mjs (lines 13-94)
// Seed one carbon_intensity_tkm derived value per CURRENT, licence-clear emission factor, each with its edge to the factor, through the one authoring path (authorEdges: once per method, version and input).
// A superseded factor is history and gets none; a factor whose source may not be re-served is counted, never seeded; a factor the method refuses is counted; a second run creates nothing.
// A runtime function (dry flag, no CLI); the method is the market slice's.
import { mayEmbedAsSeed } from "@/core/contracts";
import { admitFactors } from "@/core/derived/admissible";
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import { authorEdges, createMethodRegistry, type MarketMethodDeps } from "@/core/propagation";
import { buildCarbonMethod, CARBON_METHOD_ID, CARBON_METHOD_VERSION } from "@/core/propagation/methods";
import type { RunResult } from "@/core/sources/run-result";

export { CARBON_METHOD_ID, CARBON_METHOD_VERSION };

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
  const rows = await fetchAllRows<FactorRow>((from, to) => admitFactors(deps.sb.from("emission_factors").select("factor_id,quantity_basis,ttw_co2e,wtw_co2e,wtt_co2e,source_key,origin_class,pedigree")).order("factor_id", { ascending: true }).range(from, to), { cap: 200_000 });
  const registry = createMethodRegistry();
  registry.register("derived_values", CARBON_METHOD_ID, CARBON_METHOD_VERSION, buildCarbonMethod({ carbonIntensity: deps.carbonIntensity }));
  const counts: Record<string, number> = { total: rows.length, licence_blocked: 0, refused: 0, would_create: 0, created: 0, already: 0, failed: 0 };
  const bump = (k: string): void => void (counts[k] = (counts[k] ?? 0) + 1);
  const notes: string[] = [];
  for (const factor of rows) {
    if (!mayEmbedAsSeed(factor.source_key)) {
      bump("licence_blocked");
      continue;
    }
    if (input.dry) {
      bump(deps.carbonIntensity(factor as unknown as Parameters<MarketMethodDeps["carbonIntensity"]>[0]).ok ? "would_create" : "refused");
      continue;
    }
    try {
      const res = await authorEdges(deps.sb, { table: "emission_factors", id: factor.factor_id, method: { id: CARBON_METHOD_ID, version: CARBON_METHOD_VERSION }, inputs: [{ table: "emission_factors", pk: factor.factor_id }] }, { now: deps.now, registry });
      if (!res.ok) bump(res.action === "method-refused" ? "refused" : "failed");
      else bump(res.action === "authored" ? "created" : "already");
      if (!res.ok && res.action !== "method-refused") notes.push(`emission_factors ${factor.factor_id}: ${res.reason}`);
    } catch (e) {
      bump("failed");
      notes.push(`emission_factors ${factor.factor_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const failed = counts.failed ?? 0;
  return { counts, outcome: failed === 0 ? "ok" : (counts.created ?? 0) > 0 ? "partial" : "failed", notes: input.dry ? [...notes, "dry: nothing written"] : notes };
}
