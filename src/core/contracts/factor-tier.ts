// Ported from old_repo/src/lib/contracts/factor-tier.mjs (lines 1-403)
import { z } from "zod";

import { numbersSumExactly } from "@/core/parse";

import raw from "./data/factor-tiers.json";
import { DERIVATION } from "./envelope";
import { attributionsFor, mayEmbedAsSeed } from "./source-licence";
import { LEG_MODE_CODES, ORIGIN_CLASS, PEDIGREE_AXES } from "./vocabularies";

const tier = z.object({ code: z.string(), rank: z.number(), label: z.string(), pedigreeFloor: z.number(), isPrimaryData: z.boolean(), note: z.string() });
const scope = z.object({ code: z.string(), specificity: z.number(), label: z.string(), requires: z.array(z.string()), forbids: z.array(z.string()), note: z.string() });
const file = z.object({ tiers: z.record(z.string(), tier), scope_kinds: z.record(z.string(), scope), quantity_basis: z.array(z.string()), gwp_basis: z.array(z.string()) });
const data = file.parse(raw);

/** The hierarchy, best first (LOWER rank wins). A tier may not claim a better pedigree than its floor, so a default never presents as primary data. */
export const FACTOR_TIERS: Readonly<Record<string, z.infer<typeof tier>>> = Object.freeze(data.tiers);
export const TIER_CODES: readonly string[] = Object.keys(FACTOR_TIERS).sort((a, b) => (FACTOR_TIERS[a]?.rank ?? 0) - (FACTOR_TIERS[b]?.rank ?? 0));
const SCOPE_KINDS = data.scope_kinds;
const SCOPE_CODES = Object.keys(SCOPE_KINDS).sort((a, b) => (SCOPE_KINDS[a]?.specificity ?? 0) - (SCOPE_KINDS[b]?.specificity ?? 0));

export const isPrimaryData = (tierCode: string): boolean => FACTOR_TIERS[tierCode]?.isPrimaryData === true;

export interface Factor {
  tier: string;
  scope_kind: string;
  source_key: string;
  as_at_date: string;
  valid_from: string;
  valid_to?: string | null;
  quantity_basis: string;
  gwp_basis: string;
  wtt_co2e?: number | null;
  ttw_co2e?: number | null;
  wtw_co2e?: number | null;
  pedigree?: number | null;
  donor?: string | null;
  superseded_by?: string | null;
  [column: string]: unknown;
}

const blank = (v: unknown): boolean => v === undefined || v === null || v === "";

/** Errors for a candidate factor row; empty means usable. A factor without a source key cannot be licence-checked, without an as-at date cannot be aged. */
export function validateFactor(f: Partial<Factor> | null | undefined): string[] {
  if (!f || typeof f !== "object") return ["factor must be an object"];
  const errors: string[] = [];
  if (!FACTOR_TIERS[String(f.tier)]) errors.push(`unknown tier: ${String(f.tier)}`);
  const scope = SCOPE_KINDS[String(f.scope_kind)];
  if (!scope) errors.push(`unknown scope_kind: ${String(f.scope_kind)} (one of ${SCOPE_CODES.join(", ")})`);
  else {
    for (const req of scope.requires) if (blank(f[req])) errors.push(`scope_kind "${f.scope_kind}" requires ${req}`);
    for (const forb of scope.forbids) if (!blank(f[forb])) errors.push(`scope_kind "${f.scope_kind}" must not carry ${forb}`);
  }
  if (!blank(f.corridor_id) && !/^cl:corridor:[0-9a-f]{16}$/.test(String(f.corridor_id))) errors.push('corridor_id must be a content-addressed key "cl:corridor:<16 hex>"');

  // At least one of the three is required; all three stated must agree (a split that does not add up is a transcription error).
  const nums = ["wtt_co2e", "ttw_co2e", "wtw_co2e"] as const;
  const present = nums.filter((k) => f[k] !== undefined && f[k] !== null);
  for (const k of present) if (typeof f[k] !== "number" || !Number.isFinite(f[k]) || (f[k] as number) < 0) errors.push(`${k} must be a non-negative finite number`);
  if (present.length === 0) errors.push("at least one of wtt_co2e, ttw_co2e, wtw_co2e is required");
  if (present.length === 3 && present.every((k) => typeof f[k] === "number" && Number.isFinite(f[k]))) {
    const check = numbersSumExactly(f.wtt_co2e as number, f.ttw_co2e as number, f.wtw_co2e as number);
    if (!check.ok) errors.push(`wtw_co2e ${f.wtw_co2e} does not equal wtt_co2e + ttw_co2e (${check.sum})`);
  }
  if (!data.quantity_basis.includes(String(f.quantity_basis))) errors.push(`quantity_basis must be one of ${data.quantity_basis.join(", ")}`);
  if (!data.gwp_basis.includes(String(f.gwp_basis))) errors.push(`gwp_basis must be one of ${data.gwp_basis.join(", ")}; "unstated" is allowed, guessing is not`);

  if (!f.source_key) errors.push("source_key is required, so the licence gate can be applied");
  if (!f.as_at_date) errors.push("as_at_date is required, so the value can be aged");
  if (!f.valid_from) errors.push("valid_from is required: a shipment is costed with the factor that was correct on its date, not the newest one");
  if (f.valid_to && f.valid_from && String(f.valid_to) <= String(f.valid_from)) errors.push("valid_to must be after valid_from");
  if (f.pedigree !== undefined && f.pedigree !== null) {
    const floor = FACTOR_TIERS[String(f.tier)]?.pedigreeFloor;
    if (!Number.isInteger(f.pedigree) || f.pedigree < 1 || f.pedigree > 5) errors.push("pedigree must be an integer 1..5 (1 = best)");
    else if (floor !== undefined && f.pedigree < floor) errors.push(`pedigree ${f.pedigree} is better than tier "${f.tier}" may claim (floor ${floor}); a default must not present as primary data`);
  }
  if (f.tier === "proxy_estimate" && !f.donor) errors.push("a proxy_estimate must name its donor");
  return errors;
}

export interface Skipped {
  factor: Partial<Factor>;
  reason: "invalid" | "superseded" | "out_of_window" | "licence";
  detail: string[];
}

/**
 * INV-174: the ACTIVE factor from candidates for one corridor and mode, ordered by tier rank, then scope specificity, then recency.
 * An invalid, superseded, out-of-window or licence-unclear candidate is SKIPPED and reported, never served.
 */
export function resolveActiveFactor(candidates: Partial<Factor>[] | null | undefined, opts: { onDate?: string | null; allowUnlicensed?: boolean } = {}): { factor: Partial<Factor> | null; attribution: string[]; skipped: Skipped[] } {
  const onDate = opts.onDate ?? null;
  const usable: Factor[] = [];
  const skipped: Skipped[] = [];
  for (const f of candidates ?? []) {
    const errors = validateFactor(f);
    if (errors.length) skipped.push({ factor: f, reason: "invalid", detail: errors });
    else if (f.superseded_by) skipped.push({ factor: f, reason: "superseded", detail: [`superseded by ${f.superseded_by}`] });
    else if (onDate && ((f.valid_from && onDate < String(f.valid_from)) || (f.valid_to && onDate >= String(f.valid_to)))) skipped.push({ factor: f, reason: "out_of_window", detail: [`not valid on ${onDate} (valid_from ${f.valid_from}, valid_to ${f.valid_to ?? "open"})`] });
    else if (opts.allowUnlicensed !== true && !mayEmbedAsSeed(String(f.source_key))) skipped.push({ factor: f, reason: "licence", detail: [`source "${f.source_key}" is not clear for re-serving`] });
    else usable.push(f as Factor);
  }
  usable.sort(
    (a, b) =>
      (FACTOR_TIERS[a.tier]?.rank ?? 99) - (FACTOR_TIERS[b.tier]?.rank ?? 99) ||
      (SCOPE_KINDS[a.scope_kind]?.specificity ?? 99) - (SCOPE_KINDS[b.scope_kind]?.specificity ?? 99) ||
      String(b.as_at_date).localeCompare(String(a.as_at_date)),
  );
  const factor = usable[0] ?? null;
  return { factor, attribution: factor ? attributionsFor([factor.source_key]) : [], skipped };
}

/** Primary-data share across a chain, weighted by tonne-km (never leg count); null, not 0, when there are no legs. */
export function primaryDataShare(legs: { tkm?: unknown; tier?: string }[] | null | undefined): number | null {
  let total = 0;
  let primary = 0;
  for (const l of legs ?? []) {
    const tkm = Number(l?.tkm);
    if (!Number.isFinite(tkm) || tkm <= 0) continue;
    total += tkm;
    if (isPrimaryData(String(l.tier))) primary += tkm;
  }
  return total === 0 ? null : primary / total;
}

const list = (arr: readonly string[]) => arr.map((v) => `'${v}'`).join(", ");

/** SQL parity: the CHECK constraints of emission_factors, generated from this module so the table cannot disagree with the resolver. */
export function renderTierConstraintsSql(): string {
  const floors = TIER_CODES.map((t) => `    (tier = '${t}' AND pedigree >= ${FACTOR_TIERS[t]?.pedigreeFloor})`).join("\n    OR\n");
  const scopeRules = SCOPE_CODES.map((s) => {
    const k = SCOPE_KINDS[s];
    const parts = [...(k?.requires ?? []).map((c) => `${c} IS NOT NULL`), ...(k?.forbids ?? []).map((c) => `${c} IS NULL`)].join(" AND ");
    return `    CONSTRAINT emission_factors_scope_${s} CHECK (\n      scope_kind <> '${s}' OR (${parts})\n    )`;
  }).join(",\n");
  return `-- GENERATED by src/core/contracts/factor-tier.ts renderTierConstraintsSql(). DO NOT EDIT BY HAND.
    -- LEG modes only. \`multimodal\` is a corridor-level value: a factor is per leg, so a multimodal
    -- factor is a category error rather than a missing row.
    CONSTRAINT emission_factors_mode CHECK (mode IN (${list(LEG_MODE_CODES)})),
    CONSTRAINT emission_factors_tier CHECK (tier IN (${list(TIER_CODES)})),
    CONSTRAINT emission_factors_scope_kind CHECK (scope_kind IN (${list(SCOPE_CODES)})),
    CONSTRAINT emission_factors_quantity_basis CHECK (quantity_basis IN (${list(data.quantity_basis)})),
    CONSTRAINT emission_factors_gwp_basis CHECK (gwp_basis IN (${list(data.gwp_basis)})),
    -- 1 = BEST (ecoinvent/Weidema, as ISO 14083 uses it). A tier may not claim a better pedigree than
    -- its floor, so a modelled default can never be stored as though it were primary data.
    CONSTRAINT emission_factors_pedigree_floor CHECK (
${floors}
    ),
${scopeRules}`;
}

/** SQL parity: the five pedigree axis columns plus the envelope enumerations, from the modules that define them. */
export function renderEnvelopeColumnsSql(): string {
  const axisCols = PEDIGREE_AXES.map((axis) => `    pedigree_${axis} smallint CHECK (pedigree_${axis} BETWEEN 1 AND 5),`).join("\n");
  return `-- GENERATED by src/core/contracts/factor-tier.ts renderEnvelopeColumnsSql(). DO NOT EDIT BY HAND.
    derivation text NOT NULL CHECK (derivation IN (${list(Object.keys(DERIVATION))})),
    origin_class text NOT NULL CHECK (origin_class IN (${list(Object.keys(ORIGIN_CLASS))})),
    pedigree smallint NOT NULL CHECK (pedigree BETWEEN 1 AND 5),
${axisCols}
    method_version text NOT NULL,`;
}

/** SQL parity for READ: the eligibility view (SQL owns eligibility, code owns selection); ranks are generated so the two cannot disagree on order. */
export function renderFactorCandidateViewSql(): string {
  const tierCases = TIER_CODES.map((t) => `    WHEN '${t}' THEN ${FACTOR_TIERS[t]?.rank}`).join("\n");
  const scopeCases = SCOPE_CODES.map((s) => `    WHEN '${s}' THEN ${SCOPE_KINDS[s]?.specificity}`).join("\n");
  return `-- GENERATED by src/core/contracts/factor-tier.ts renderFactorCandidateViewSql(). DO NOT EDIT BY HAND.
-- Ranks are codegen'd from FACTOR_TIERS and SCOPE_KINDS so the view and the JS resolver cannot disagree.
CREATE OR REPLACE VIEW public.emission_factor_candidates AS
SELECT
  f.*,
  CASE f.tier
${tierCases}
  END AS tier_rank,
  CASE f.scope_kind
${scopeCases}
  END AS scope_specificity
FROM public.emission_factors f
WHERE f.superseded_by IS NULL                 -- a superseded row is history, never a candidate
  AND f.as_at_date <= current_date            -- a future-dated row is an entry error, not the best factor
  AND f.source_key IN (SELECT source_key FROM public.licence_clear_sources);`;
}
