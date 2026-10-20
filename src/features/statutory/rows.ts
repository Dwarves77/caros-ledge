// Ported from old_repo/src/lib/propagation/statutory-rows.ts (lines 10-344)
// The FuelEU Annex IV statutory rows: validation of a session-authored rows file (no placeholder marker, every input carries a source block whose host
// resolves to a codified class tier, rule 18), parse, the per-input FILING gate (admissibleFor), the computation, the minted asset and obligation entities
// and ONE idempotent insert into statutory_computations. The target-year table covers Article 4(2) for 2025 to 2050 from the transcribed constants (BUILD-PLAN ruling 8); a year is filing grade only when
// data/filing-grade.json (DERIVED from the stored capture of the regulation, filing-grade.ts, never typed) lists it, and every quote an input cites must stand on a stored capture that holds it (run.ts).
// The formula itself (computeStatutory and its constants) is the regulations slice's, reached through StatutoryDeps.
import { z } from "zod";

import type { Db } from "@/core/db";
import { entityId, hostFromUrl, type EntityKind } from "@/core/entities/id";
import { admissibleFor } from "@/core/propagation/admissible";
import type { Admissibility, Derivation, Lifecycle, OriginClass, StatutoryInput, StatutoryResult, Value } from "@/core/propagation/types";
import { acceptStoredQuote, parseVerifiedAt } from "@/core/producers/quote";
import { classTierForHost } from "@/core/sources";

import constants from "./data/fueleu-annex-i-iv-constants.json";
import filingGrade from "./data/filing-grade.json";
import { FUELEU_INSTRUMENT } from "./filing-grade";

const FORMULA_ID = "fueleu_annex_iv_penalty";
const DEFAULT_OBLIGATION_SEED = "fueleu-maritime-annex-iv-penalty";

const periods = z.object({ ghg_intensity_limit_by_period: z.object({ periods: z.array(z.object({ from_date: z.string(), reduction_percent: z.number(), target_gco2e_per_mj: z.number(), quote: z.string() })) }), reference_value: z.object({ value: z.number(), unit: z.string() }) }).loose().parse(constants);
const FUELEU_REFERENCE_GCO2E_PER_MJ = periods.reference_value.value;
/** Target year to the Article 4(2) limit in gCO2eq/MJ, from the transcribed table (reference x (1 - reduction)). */
export const SUPPORTED_TARGET_YEARS: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries(periods.ghg_intensity_limit_by_period.periods.map((p) => [p.from_date.slice(0, 4), FUELEU_REFERENCE_GCO2E_PER_MJ * (1 - p.reduction_percent / 100)])));
const FILING_GRADE_YEARS: ReadonlySet<string> = new Set((z.object({ instruments: z.record(z.string(), z.object({ years: z.array(z.number()) }).loose()) }).loose().parse(filingGrade).instruments[FUELEU_INSTRUMENT]?.years ?? []).map(String));
const ARTICLE_4_2_CITATION = "Regulation (EU) 2023/1805, Article 4(2) (reference value 91.16 gCO2eq/MJ, reduced by the stated percentage from the stated date) and recital 23 (2020 fleet-average baseline, Regulation (EU) 2015/757 MRV data). Verified against EUR-Lex CELEX:32023R1805.";

/** What the regulations slice supplies: the formula and its published constants. */
export interface StatutoryDeps {
  computeStatutory(formulaId: string, inputs: Record<string, StatutoryInput>): StatutoryResult;
  formulaVersion: string;
  statuteCitation: string;
  unitPriceEurPerTVlsfoe: number;
}

const PLACEHOLDER_MARKERS = /\b(FIXTURE|SYNTHETIC|PLACEHOLDER|TODO|TBD|EXAMPLE ONLY)\b/i;
const REQUIRED_SOURCE_FIELDS = ["url", "article", "quote", "verified_at"] as const;
const REQUIRED_INPUT_KEYS = ["ghgIntensityActual", "energyUsedMJ", "consecutiveDeficitYears"] as const;
type Rec = Record<string, unknown>;

export interface RowInputBlock extends StatutoryInput {
  originClass: OriginClass;
  lifecycle: Lifecycle;
  admissibility: Admissibility;
  baseConfidence: number;
  halfLifeDays?: number | null;
  obsStatus?: string | null;
  source?: Rec;
}
export interface ParsedStatutoryRow {
  shipKey: string;
  scenarioKey: string;
  obligationSeed: string;
  targetYear: number;
  ghgIntensityActual: RowInputBlock;
  energyUsedMJ: RowInputBlock;
  consecutiveDeficitYears: RowInputBlock;
}

/** Problems with a source block: all four fields, and a host that resolves to a codified class tier (an unrated host is worklisted, never given a guessed tier). */
export function validateSourceBlock(source: unknown, where: string): string[] {
  if (!source || typeof source !== "object") return [`${where}: missing a \`source\` block ({url, article, quote, verified_at}), refused, not guessed (rule 18).`];
  const block = source as Rec;
  const violations: string[] = [];
  for (const f of REQUIRED_SOURCE_FIELDS) if (typeof block[f] !== "string" || !(block[f] as string).trim()) violations.push(`${where}.source.${f} is required and must be a non-empty string.`);
  if (typeof block.verified_at === "string" && block.verified_at.trim() && !parseVerifiedAt(block.verified_at)) violations.push(`${where}.source.verified_at "${block.verified_at}" is not a date (YYYY-MM-DD).`);
  if (typeof block.url === "string" && block.url.trim()) {
    const host = hostFromUrl(block.url);
    if (!host) violations.push(`${where}.source.url is not a valid absolute URL: "${block.url}"`);
    else if (classTierForHost(host) == null) violations.push(`${where}.source.url's host "${host}" does not resolve to a codified class (classTierForHost); an ambiguous host is worklisted, never guessed a tier. A real EU statutory source resolves to eur-lex.europa.eu (T1) or a europa.eu/gov host (T2).`);
  }
  return violations;
}
function validateRow(row: unknown, index: number): string[] {
  const r = (row ?? {}) as Rec;
  const shipKey = String(r.shipKey ?? `row[${index}]`);
  const violations: string[] = PLACEHOLDER_MARKERS.test(shipKey) ? [`row[${index}] (${shipKey}): shipKey itself carries a placeholder marker, not a real ship key.`] : [];
  for (const key of REQUIRED_INPUT_KEYS) {
    const where = `row[${index}] (${shipKey}).${key}`;
    const input = r[key];
    if (!input || typeof input !== "object") {
      violations.push(`${where}: missing.`);
      continue;
    }
    const block = input as Rec;
    if (typeof block.citation === "string" && PLACEHOLDER_MARKERS.test(block.citation)) violations.push(`${where}.citation carries a placeholder marker ("${block.citation.slice(0, 80)}..."), a real filing's citation names the real source.`);
    violations.push(...validateSourceBlock(block.source, where));
  }
  return violations;
}
export function validateRowsFile(parsed: unknown): string[] {
  const p = (parsed ?? {}) as Rec;
  const violations: string[] = [];
  if (typeof p._file_status === "string" && PLACEHOLDER_MARKERS.test(p._file_status)) violations.push(`_file_status carries a placeholder marker, this file self-identifies as non-production ("${p._file_status.slice(0, 120)}...").`);
  const rows = Array.isArray(parsed) ? parsed : p.rows;
  if (!Array.isArray(rows) || !rows.length) return [...violations, "no rows[] array (or empty), refusing to validate an empty file as apply-ready."];
  rows.forEach((row: unknown, i: number) => violations.push(...validateRow(row, i)));
  return violations;
}

function requireFields(row: unknown, fields: readonly string[], where: string): void {
  const r = (row ?? {}) as Rec;
  const missing = fields.filter((f) => r[f] === undefined || r[f] === null);
  if (missing.length) throw new Error(`${where}: missing required field(s): ${missing.join(", ")}`);
}
/** A rows-file row to its parsed form; throws on a missing field or a target year the table does not hold. */
export function parseRow(row: unknown, index: number): ParsedStatutoryRow {
  requireFields(row, ["shipKey", "targetYear", "ghgIntensityActual", "energyUsedMJ", "consecutiveDeficitYears"], `statutory: row[${index}]`);
  const r = row as Rec;
  if (!Object.hasOwn(SUPPORTED_TARGET_YEARS, String(r.targetYear))) throw new Error(`statutory: row[${index}] (ship ${r.shipKey}) targetYear=${r.targetYear} is not in Article 4(2)'s table (${Object.keys(SUPPORTED_TARGET_YEARS).join(", ")}). Refused, not guessed.`);
  for (const key of REQUIRED_INPUT_KEYS) {
    const v = r[key] as Rec | undefined;
    requireFields(v, ["value", "unit", "citation", "asOf", "derivation", "originClass", "lifecycle", "admissibility", "baseConfidence"], `statutory: row[${index}].${key}`);
    requireFields(v?.asOf, ["eventDate"], `statutory: row[${index}].${key}.asOf`);
  }
  return { shipKey: String(r.shipKey), scenarioKey: r.scenarioKey ? String(r.scenarioKey) : "default", obligationSeed: r.obligationSeed ? String(r.obligationSeed) : DEFAULT_OBLIGATION_SEED, targetYear: r.targetYear as number, ghgIntensityActual: r.ghgIntensityActual as RowInputBlock, energyUsedMJ: r.energyUsedMJ as RowInputBlock, consecutiveDeficitYears: r.consecutiveDeficitYears as RowInputBlock };
}

/** A rows-file input as the Value the gate reads. */
function toValue(input: Pick<RowInputBlock, "value" | "unit" | "derivation" | "originClass" | "lifecycle" | "admissibility" | "baseConfidence" | "halfLifeDays" | "obsStatus" | "asOf">): Value {
  return { valueId: null, entityId: null, methodId: FORMULA_ID, methodVersion: "n/a", value: input.value, valueLow: null, valueHigh: null, unit: input.unit ?? null, currency: null, derivation: input.derivation as Derivation, originClass: input.originClass, lifecycle: input.lifecycle, admissibility: input.admissibility, baseConfidence: input.baseConfidence, assertedAt: input.asOf.eventDate, halfLifeDays: input.halfLifeDays ?? null, inputs: [], supersedes: null, computedAt: input.asOf.eventDate, computedBy: "rows-file", obsStatus: input.obsStatus ?? null };
}

/** The entity for a seed: existing, or (apply) minted. A failed read throws. */
async function resolveOrMintEntity(sb: Db, target: { kind: EntityKind; seed: string; canonicalName?: string }, apply: boolean): Promise<string> {
  const id = entityId(target.kind, target.seed);
  const { data, error } = await sb.from("entities").select("entity_id").eq("entity_id", id).maybeSingle();
  if (error) throw new Error(`resolveOrMintEntity: entities read failed: ${error.message}`);
  if (data || !apply) return id;
  const ins = await sb.from("entities").insert({ entity_id: id, kind: target.kind, canonical_name: target.canonicalName ?? target.seed });
  if (ins.error) throw new Error(`statutory-rows insert(entities) failed: ${ins.error.message}`);
  return id;
}

export type WriteResult =
  | { action: "refused-inadmissible"; field: string; reason: string; shipKey: string }
  | { action: "skipped-already-computed"; shipKey: string; computationId: unknown }
  | { action: "would-write"; shipKey: string; entity_id: string; obligation_id: string; resultEur: number }
  | { action: "written"; shipKey: string; computationId: unknown; resultEur: number }
  | { action: "errored"; shipKey: string; reason: string };

/** One row: every input must pass the FILING gate, then compute, then insert once (idempotent on ship, formula, version and scenario). */
export async function writeOneRow(sb: Db, parsed: ParsedStatutoryRow, deps: StatutoryDeps, opts: { apply: boolean; now: Date; filingYears: ReadonlySet<string>; captureIds?: Readonly<Record<string, string>> }): Promise<WriteResult> {
  const year = String(parsed.targetYear);
  const targetValue = toValue({ value: SUPPORTED_TARGET_YEARS[year] as number, unit: "gCO2eq/MJ", derivation: "statutory_fixed", originClass: "official", lifecycle: "verified", admissibility: FILING_GRADE_YEARS.has(year) && opts.filingYears.has(year) ? "filing_ok" : "calculation_ok", baseConfidence: 1, halfLifeDays: null, asOf: { eventDate: "2023-09-22" } });
  const checks: [string, Value][] = [["ghgIntensityTarget", targetValue], ["ghgIntensityActual", toValue(parsed.ghgIntensityActual)], ["energyUsedMJ", toValue(parsed.energyUsedMJ)], ["consecutiveDeficitYears", toValue(parsed.consecutiveDeficitYears)]];
  for (const [label, v] of checks) {
    const verdict = admissibleFor(v, "filing", opts.now);
    if (!verdict.ok) return { action: "refused-inadmissible", field: label, reason: verdict.reason, shipKey: parsed.shipKey };
  }
  const pick = (b: RowInputBlock): StatutoryInput => ({ derivation: b.derivation, value: b.value, unit: b.unit, citation: b.citation, asOf: b.asOf });
  const result = deps.computeStatutory(FORMULA_ID, {
    ghgIntensityTarget: { derivation: "statutory_fixed", value: targetValue.value as number, unit: "gCO2eq/MJ", citation: ARTICLE_4_2_CITATION, asOf: { eventDate: "2023-09-22" } },
    ghgIntensityActual: pick(parsed.ghgIntensityActual), energyUsed: pick(parsed.energyUsedMJ), consecutiveYears: pick(parsed.consecutiveDeficitYears),
  });
  const entity_id = await resolveOrMintEntity(sb, { kind: "asset", seed: parsed.shipKey, canonicalName: parsed.shipKey }, opts.apply);
  const obligation_id = await resolveOrMintEntity(sb, { kind: "obligation", seed: parsed.obligationSeed, canonicalName: "FuelEU Maritime Annex IV penalty obligation" }, opts.apply);
  const existing = await sb.from("statutory_computations").select("computation_id").eq("entity_id", entity_id).eq("formula_id", FORMULA_ID).eq("formula_version", deps.formulaVersion).eq("scenario_key", parsed.scenarioKey).order("computation_id", { ascending: true }).limit(1);
  if (existing.error) throw new Error(`statutory_computations read failed: ${existing.error.message}`);
  const held = (existing.data ?? [])[0] as { computation_id: unknown } | undefined;
  if (held) return { action: "skipped-already-computed", shipKey: parsed.shipKey, computationId: held.computation_id };
  if (!opts.apply) return { action: "would-write", shipKey: parsed.shipKey, entity_id, obligation_id, resultEur: result.result };
  const ins = await sb.from("statutory_computations").insert({
    entity_id, scenario_key: parsed.scenarioKey, obligation_id, formula_id: FORMULA_ID, formula_version: deps.formulaVersion, statute_citation: deps.statuteCitation, unit_price: deps.unitPriceEurPerTVlsfoe, unit_price_unit: "EUR/t_VLSFOe",
    inputs: [
      { table: "reported:ghg_intensity_target", pk: parsed.shipKey, version: ARTICLE_4_2_CITATION },
      { table: "reported:ghg_intensity_actual", pk: parsed.shipKey, version: parsed.ghgIntensityActual.citation, capture_id: opts.captureIds?.ghgIntensityActual ?? null },
      { table: "reported:energy_used_mj", pk: parsed.shipKey, version: parsed.energyUsedMJ.citation, capture_id: opts.captureIds?.energyUsedMJ ?? null },
      { table: "reported:consecutive_deficit_years", pk: parsed.shipKey, version: parsed.consecutiveDeficitYears.citation, capture_id: opts.captureIds?.consecutiveDeficitYears ?? null },
    ],
    result: result.result, result_unit: result.resultUnit,
  }).select("computation_id").single();
  return ins.error ? { action: "errored", shipKey: parsed.shipKey, reason: ins.error.message } : { action: "written", shipKey: parsed.shipKey, computationId: (ins.data as { computation_id: unknown }).computation_id, resultEur: result.result };
}

/** The quote of every input must stand on a stored capture that holds it verbatim, with a verified_at that parses (acceptStoredQuote: the one rule): the capture id per input, or the first refusal. */
export async function verifyRowQuotes(sb: Db, row: unknown, now: Date, texts: Map<string, string> = new Map()): Promise<{ ok: true; captureIds: Record<string, string> } | { ok: false; reason: string }> {
  const captureIds: Record<string, string> = {};
  for (const key of REQUIRED_INPUT_KEYS) {
    const src = ((row as Rec)?.[key] as Rec | undefined)?.source as Rec | undefined;
    const verdict = await acceptStoredQuote(sb, { url: String(src?.url ?? ""), quote: String(src?.quote ?? ""), verifiedAt: src?.verified_at, now }, texts);
    if (!verdict.ok) return { ok: false, reason: `${key}: ${verdict.reason} (${verdict.detail})` };
    captureIds[key] = verdict.captureId;
  }
  return { ok: true, captureIds };
}
