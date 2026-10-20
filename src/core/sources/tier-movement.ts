// Ported from old_repo/src/lib/trust.ts (lines 189-279)
// Ported from old_repo/src/lib/trust.ts (lines 332-503)
// Ported from old_repo/src/lib/trust.ts (lines 632-647)
// Ported from old_repo/src/lib/trust.ts (lines 689-702)
// Ported from old_repo/src/lib/trust.ts (lines 711-838)
// Ported from old_repo/src/lib/trust.ts (lines 840-1127)
// Ported from old_repo/src/lib/trust.ts (lines 1266-1606)
// Ported from old_repo/src/lib/sources/tier-override-guard.mjs (lines 1-36)
import type { Db } from "@/core/db";
import { getScrapeState } from "@/core/fetch/hold";

import movement from "./data/tier-movement.json";
import { TIER_WEIGHTS } from "./tier-contract";
import { computeOverallScore, TIER_SOURCE_COLUMNS, trustMetricsFromRow, type TierSourceRow } from "./trust-score";
import type { DemotionTrigger, PromotionCriteria, SourceTier } from "./types";

const PROMOTION = movement.promotionCriteria as PromotionCriteria[];
const DEMOTION = movement.demotionTriggers as DemotionTrigger[];
const CFG = { ...movement.q7, ...movement.movement };
const FREQ_DAYS = movement.updateFrequencyDays as Record<string, number>;
const MS_PER_DAY = 86_400_000;
const DAYS_PER_MONTH = 30.44;
const clampTier = (n: number): SourceTier => Math.max(1, Math.min(7, n)) as SourceTier;

/** The multiplier in [0, 1] for a citation's age: 1 now, 0.5 at one half-life, 0.25 at two. Applies to the citation network only, never to base_tier. */
function applyRecencyDecay(detectedAt: Date, now: number, halfLifeMonths: number = CFG.halfLifeMonths): number {
  return Math.pow(0.5, (now - detectedAt.getTime()) / (MS_PER_DAY * DAYS_PER_MONTH) / halfLifeMonths);
}

export interface CitationEdgeRow {
  citing_source_id: string;
  cited_source_id: string;
  detected_at: string;
}
/** The tier-weighted, decayed citation sum into one source and the promotion verdict (T7 weighs 0; a citer not found is skipped). */
function scoreCitationEdges(rows: CitationEdgeRow[], tierById: Map<string, number>, now: number, halfLifeMonths: number = CFG.halfLifeMonths) {
  let weighted_sum = 0;
  for (const row of rows) {
    const tier = tierById.get(row.citing_source_id);
    if (tier == null || tier < 1 || tier > 7) continue;
    weighted_sum += (TIER_WEIGHTS[tier] ?? 0) * applyRecencyDecay(new Date(row.detected_at), now, halfLifeMonths);
  }
  const should_promote = weighted_sum >= CFG.promotionWeightedSumThreshold && rows.length >= CFG.citationFrequencyPromotionThreshold;
  const reasoning = `weighted_sum=${weighted_sum.toFixed(3)} citations=${rows.length} ${should_promote ? "clears" : "below"} thresholds (sum>=${CFG.promotionWeightedSumThreshold}, citations>=${CFG.citationFrequencyPromotionThreshold})${should_promote ? " (promote)" : ""}`;
  return { weighted_sum, citation_count: rows.length, should_promote, reasoning };
}

/** The narrow shape the evaluators read from a source. */
export interface Evaluable {
  base_tier: SourceTier;
  status?: string | undefined;
  created_at: string;
  last_substantive_change: string | null;
  update_frequency: string;
  trust_metrics: ReturnType<typeof trustMetricsFromRow>;
  trust_overall: number;
}
export interface PromotionEvaluation {
  eligible: boolean;
  target_tier: SourceTier;
  criteria: PromotionCriteria;
  met: Record<string, boolean>;
  blocking: string[];
}
export interface DemotionEvaluation {
  triggered: boolean;
  triggers_fired: { trigger: DemotionTrigger; current_value: string }[];
  recommended_tier: SourceTier;
  /** Triggers that fired but were suppressed by the caller (the cadence hold); never counted in `triggered`. */
  held_triggers?: string[];
}
const daysSince = (iso: string, now: Date): number => Math.floor((now.getTime() - new Date(iso).getTime()) / MS_PER_DAY);

/** Promotion eligibility against the structural base_tier (promotion never reads the dynamic signal, so there is no feedback loop). T1 cannot be promoted. */
function evaluatePromotion(s: Evaluable, now: Date): PromotionEvaluation | null {
  if (s.base_tier === 1) return null;
  const c = PROMOTION.find((x) => x.from_tier === s.base_tier);
  if (!c) return null;
  const m = s.trust_metrics;
  const ageDays = daysSince(s.created_at, now);
  const rate = m.conflict_total > 0 ? m.conflict_count / m.conflict_total : 0;
  const met: Record<string, boolean> = {
    trust_score: s.trust_overall >= c.min_trust_score,
    confirmation_count: m.confirmation_count >= c.min_confirmation_count,
    conflict_rate: m.conflict_total === 0 || rate <= c.max_conflict_rate,
    independent_citers: m.independent_citers >= c.min_independent_citers,
    accessibility_rate: m.accessibility_rate >= c.min_accessibility_rate,
    age_days: ageDays >= c.min_age_days,
    lead_time_samples: m.lead_time_samples >= c.min_lead_time_samples,
  };
  const why: Record<string, string> = {
    trust_score: `Trust score ${s.trust_overall} < required ${c.min_trust_score}`,
    confirmation_count: `Confirmations ${m.confirmation_count} < required ${c.min_confirmation_count}`,
    conflict_rate: `Conflict rate ${(rate * 100).toFixed(1)}% > max ${c.max_conflict_rate * 100}%`,
    independent_citers: `Independent citers ${m.independent_citers} < required ${c.min_independent_citers}`,
    accessibility_rate: `Accessibility ${(m.accessibility_rate * 100).toFixed(1)}% < required ${c.min_accessibility_rate * 100}%`,
    age_days: `Age ${ageDays} days < required ${c.min_age_days} days`,
    lead_time_samples: `Lead time samples ${m.lead_time_samples} < required ${c.min_lead_time_samples}`,
  };
  const blocking = Object.entries(met).filter(([, v]) => !v).map(([k]) => why[k] ?? k);
  return { eligible: blocking.length === 0, target_tier: c.to_tier, criteria: c, met, blocking };
}

/** Demotion: ANY single trigger fires it. `suppress` holds triggers aside (the cadence hold, rule 16) so they are counted as held and contribute nothing. */
function evaluateDemotion(s: Evaluable, now: Date, opts: { suppress?: readonly string[] } = {}): DemotionEvaluation {
  const m = s.trust_metrics;
  const fired: DemotionEvaluation["triggers_fired"] = [];
  const held: string[] = [];
  for (const trigger of DEMOTION) {
    if (!trigger.tiers_affected.includes(s.base_tier)) continue;
    let value: string | null = null;
    switch (trigger.trigger) {
      case "high_conflict_rate":
        if (m.conflict_total >= 3 && m.conflict_count / m.conflict_total > 0.3) value = `${((m.conflict_count / m.conflict_total) * 100).toFixed(1)}% conflict rate (${m.conflict_count}/${m.conflict_total})`;
        break;
      case "extended_inaccessibility":
        if (s.status === "inaccessible" && m.last_accessible && daysSince(m.last_accessible, now) > 30) value = `${daysSince(m.last_accessible, now)} days since last accessible`;
        break;
      case "chronic_inaccessibility":
        if (m.total_checks >= 10 && m.accessibility_rate < 0.5) value = `${(m.accessibility_rate * 100).toFixed(1)}% accessibility over ${m.total_checks} checks`;
        break;
      case "no_substantive_update": {
        const expected = FREQ_DAYS[s.update_frequency.toLowerCase()] ?? 0;
        if (s.last_substantive_change && expected > 0 && daysSince(s.last_substantive_change, now) > expected * 3) value = `${daysSince(s.last_substantive_change, now)} days since update (expected every ${expected} days)`;
        break;
      }
      case "self_citation_only":
        if (m.independent_citers === 0 && m.self_citation_count > 0 && daysSince(s.created_at, now) > 90) value = `${m.self_citation_count} self-citations, 0 independent citers, ${daysSince(s.created_at, now)} days old`;
        break;
    }
    if (value === null) continue;
    if (opts.suppress?.includes(trigger.trigger)) held.push(trigger.trigger);
    else fired.push({ trigger, current_value: value });
  }
  return { triggered: fired.length > 0, triggers_fired: fired, recommended_tier: fired.length > 0 ? clampTier(s.base_tier + 1) : s.base_tier, ...(held.length > 0 ? { held_triggers: held } : {}) };
}

export interface TierOpinionRow {
  target_source_id?: string;
  opined_tier: number;
  opining_source_id: string | null;
  opined_at: string;
  dismissed_at: string | null;
  opinion_source: string | null;
}
export interface OpinionMovement {
  delta: -1 | 0 | 1;
  counted: number;
  distinct_opiners: number;
  median: number | null;
  reason: string;
}
/** The one-step movement the tier opinions argue for: 3 or more non-dismissed opinions in the window from at least 2 distinct opiners, class-table opinions excluded. */
function opinionMovement(baseTier: number, opinions: TierOpinionRow[], now: Date): OpinionMovement {
  const since = now.getTime() - CFG.opinionWindowDays * MS_PER_DAY;
  const counted = opinions.filter((o) => o.dismissed_at == null && !movement.nonEvidenceOpinionSources.includes(o.opinion_source ?? "") && new Date(o.opined_at).getTime() >= since && o.opined_tier >= 1 && o.opined_tier <= 7);
  const distinct = new Set(counted.map((o) => o.opining_source_id).filter((id): id is string => !!id)).size;
  if (counted.length < CFG.opinionMinCount || distinct < CFG.opinionMinDistinctOpiners) {
    return { delta: 0, counted: counted.length, distinct_opiners: distinct, median: null, reason: `opinions=${counted.length} distinct_opiners=${distinct} below thresholds (n>=${CFG.opinionMinCount}, distinct>=${CFG.opinionMinDistinctOpiners})` };
  }
  const sorted = counted.map((o) => o.opined_tier).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return { delta: median < baseTier ? -1 : median > baseTier ? 1 : 0, counted: counted.length, distinct_opiners: distinct, median, reason: `opinions=${counted.length} distinct_opiners=${distinct} median=${median} base=${baseTier}` };
}

export interface OutcomeTally {
  held: number;
  refuted: number;
  partial: number;
}
export interface OutcomeMovement extends OutcomeTally {
  delta: -1 | 0 | 1;
  sample: number;
  window_days: number;
  reason: string;
}
/** The one-step movement a source's scored prediction outcomes argue for (ADR-044): refuted over held moves toward demotion; held with no refuted, toward promotion. */
function outcomeMovement(tally: OutcomeTally | null | undefined): OutcomeMovement {
  const held = tally?.held ?? 0;
  const refuted = tally?.refuted ?? 0;
  const partial = tally?.partial ?? 0;
  const sample = held + refuted + partial;
  const base = { held, refuted, partial, sample, window_days: CFG.outcomeWindowDays };
  if (sample < CFG.outcomeMinSample) return { ...base, delta: 0, reason: `outcomes=${sample} below minimum sample (n>=${CFG.outcomeMinSample})` };
  if (refuted > held) return { ...base, delta: 1, reason: `outcomes held=${held} refuted=${refuted} partial=${partial}: refuted over held` };
  if (refuted === 0 && held > 0) return { ...base, delta: -1, reason: `outcomes held=${held} refuted=0 partial=${partial}: held with no refuted` };
  return { ...base, delta: 0, reason: `outcomes held=${held} refuted=${refuted} partial=${partial}: mixed record` };
}
export interface OutcomeRow {
  source_id: string;
  outcome: string;
  scored_at: string;
}
function tallyOutcomes(rows: OutcomeRow[], now: Date): Map<string, OutcomeTally> {
  const since = now.getTime() - CFG.outcomeWindowDays * MS_PER_DAY;
  const out = new Map<string, OutcomeTally>();
  for (const r of rows) {
    if (r.outcome !== "held" && r.outcome !== "refuted" && r.outcome !== "partial") continue;
    if (new Date(r.scored_at).getTime() < since) continue;
    const t = out.get(r.source_id) ?? { held: 0, refuted: 0, partial: 0 };
    t[r.outcome] += 1;
    out.set(r.source_id, t);
  }
  return out;
}

export interface TierEvidence {
  citation_promote: boolean;
  citation_reasoning: string;
  promotion: PromotionEvaluation | null;
  demotion: DemotionEvaluation | null;
  opinion: OpinionMovement;
  outcome?: OutcomeMovement | undefined;
}
export interface TierMovementDecision {
  before_tier: SourceTier;
  after_tier: SourceTier;
  changed: boolean;
  base_tier: SourceTier;
  computed_dynamic_tier: SourceTier;
  tier_override: SourceTier | null;
  /** True when an admin override is set: the machine writes nothing for this source. */
  override_held: boolean;
  deltas: { citation: number; promotion: number; demotion: number; opinion: number; outcome: number };
  net: number;
  outcome_driven: boolean;
  rules: string[];
  inputs: Record<string, unknown>;
  reasoning: string;
}

/** THE effective_tier calculator. tier_override wins; else clamp(base_tier + clamp(sum of evidence deltas, -1, +1)). An override reports itself but `changed` is false: an automatic writer never writes over it. */
function decideEffectiveTier(input: { base_tier: SourceTier; effective_tier: SourceTier | null; tier_override: SourceTier | null; evidence: TierEvidence }): TierMovementDecision {
  const { base_tier, effective_tier, tier_override, evidence } = input;
  const before_tier = effective_tier ?? base_tier;
  const deltas = { citation: evidence.citation_promote ? -1 : 0, promotion: evidence.promotion?.eligible ? -1 : 0, demotion: evidence.demotion?.triggered ? 1 : 0, opinion: evidence.opinion.delta as number, outcome: (evidence.outcome?.delta ?? 0) as number };
  const rules = [deltas.citation && "citation_promotion", deltas.promotion && "evaluate_promotion", deltas.demotion && "evaluate_demotion", deltas.opinion && "tier_opinions", deltas.outcome && "prediction_outcomes"].filter((r): r is string => typeof r === "string");
  const sum = deltas.citation + deltas.promotion + deltas.demotion + deltas.opinion + deltas.outcome;
  const clampNet = (n: number) => Math.max(-CFG.maxNetStep, Math.min(CFG.maxNetStep, n));
  const net = clampNet(sum);
  const computed_dynamic_tier = clampTier(base_tier + net);
  const tier_without_outcome = clampTier(base_tier + clampNet(sum - deltas.outcome));
  const override_held = tier_override != null;
  const after_tier = override_held ? (tier_override as SourceTier) : computed_dynamic_tier;
  const changed = !override_held && after_tier !== before_tier;
  const outcome_driven = changed && deltas.outcome !== 0 && tier_without_outcome !== after_tier;
  const inputs: Record<string, unknown> = {
    citation: { promote: evidence.citation_promote, reasoning: evidence.citation_reasoning },
    promotion: evidence.promotion ? { eligible: evidence.promotion.eligible, target_tier: evidence.promotion.target_tier, blocking: evidence.promotion.blocking } : null,
    demotion: evidence.demotion ? { triggered: evidence.demotion.triggered, triggers: evidence.demotion.triggers_fired.map((t) => ({ trigger: t.trigger.trigger, current_value: t.current_value })) } : null,
    opinion: { counted: evidence.opinion.counted, distinct_opiners: evidence.opinion.distinct_opiners, median: evidence.opinion.median, window_days: CFG.opinionWindowDays },
    outcome: evidence.outcome ?? null,
  };
  const evidenceNote = `${evidence.citation_reasoning}; ${evidence.opinion.reason}${evidence.outcome ? `; ${evidence.outcome.reason}` : ""}`;
  const reasoning = override_held
    ? `effective_tier held at admin override ${tier_override}: base=${base_tier} (no machine write)`
    : `effective_tier ${changed ? `${before_tier} -> ${after_tier}` : `unchanged at ${after_tier}`}: base=${base_tier} net=${net} rules=${rules.join("+") || "none"} (${evidenceNote})`;
  return { before_tier, after_tier, changed, base_tier, computed_dynamic_tier, tier_override, override_held, deltas, net, outcome_driven, rules, inputs, reasoning };
}

/** The Evaluable view of a sources row, with the prior-blended overall score. */
function evaluableFromRow(s: TierSourceRow): Evaluable {
  const metrics = trustMetricsFromRow(s);
  return { base_tier: s.base_tier as SourceTier, status: s.status ?? undefined, created_at: s.created_at, last_substantive_change: s.last_substantive_change, update_frequency: s.update_frequency ?? "ad-hoc", trust_metrics: metrics, trust_overall: computeOverallScore(metrics, s.base_tier) };
}
/** Promotion and demotion over one sources row. While the scrape cadence is off the no_substantive_update trigger is held: scan timestamps cannot advance, so it would fire on every unscanned source (rule 16). */
function evaluateTierEvidenceForRow(s: TierSourceRow, now: Date, opts: { scrapeCadence?: string | null } = {}) {
  const e = evaluableFromRow(s);
  return { promotion: evaluatePromotion(e, now), demotion: evaluateDemotion(e, now, { suppress: opts.scrapeCadence === "off" ? movement.cadenceHeldTriggers : [] }) };
}

export interface TierMovementReaders {
  readSources(): Promise<TierSourceRow[]>;
  readOpinions(sinceIso: string): Promise<TierOpinionRow[]>;
  readCitations(): Promise<CitationEdgeRow[]>;
  readOutcomes?(sinceIso: string): Promise<OutcomeRow[]>;
}

export interface TierMovementPlan {
  scanned: number;
  override_held: number;
  held_cadence_off: number;
  skipped: Array<{ source_id: string; reason: string }>;
  movements: Array<{ source_id: string; name: string | null; decision: TierMovementDecision }>;
  outcome_driven_movements: number;
  /** The error text when the outcome read failed: the run continues without outcome evidence and says so. */
  outcome_read_error: string | null;
}

/**
 * Recompute one source's effective tier from all five evidence kinds and return the decision (writes nothing). Every read destructures its error and throws;
 * the cadence is read once through the fail-closed hold reader unless the caller already holds it.
 */
export async function recomputeEffectiveTier(db: Db, sourceId: string, opts: { now: Date; scrapeCadence?: string | null }) {
  const { data: src, error: srcErr } = await db.from("sources").select(TIER_SOURCE_COLUMNS).eq("id", sourceId).maybeSingle();
  if (srcErr) throw new Error(`recomputeEffectiveTier: failed to read source ${sourceId}: ${srcErr.message}`);
  if (!src) throw new Error(`recomputeEffectiveTier: source ${sourceId} not found`);
  const row = src as unknown as TierSourceRow;
  if (row.base_tier < 1 || row.base_tier > 7) throw new Error(`recomputeEffectiveTier: source ${sourceId} has out-of-range base_tier=${row.base_tier}`);
  const { data: edges, error: edgeErr } = await db.from("source_citations").select("citing_source_id, cited_source_id, detected_at").eq("cited_source_id", sourceId);
  if (edgeErr) throw new Error(`recomputeEffectiveTier: failed to read source_citations for ${sourceId}: ${edgeErr.message}`);
  const citations = (edges ?? []) as CitationEdgeRow[];
  const ids = [...new Set(citations.map((c) => c.citing_source_id))];
  const tierById = new Map<string, number>();
  if (ids.length > 0) {
    const { data: citers, error: citerErr } = await db.from("sources").select("id, base_tier, effective_tier").in("id", ids);
    if (citerErr) throw new Error(`recomputeEffectiveTier: failed to read citers of ${sourceId}: ${citerErr.message}`);
    for (const c of (citers ?? []) as Array<{ id: string; base_tier: number; effective_tier: number | null }>) tierById.set(c.id, c.effective_tier ?? c.base_tier);
  }
  const cited = citations.length === 0 ? { weighted_sum: 0, citation_count: 0, should_promote: false, reasoning: "no citations" } : scoreCitationEdges(citations, tierById, opts.now.getTime());
  const { data: ops, error: opErr } = await db.from("source_tier_opinions").select("opined_tier, opining_source_id, opined_at, dismissed_at, opinion_source").eq("target_source_id", sourceId);
  if (opErr) throw new Error(`recomputeEffectiveTier: failed to read source_tier_opinions for ${sourceId}: ${opErr.message}`);
  const cadence = opts.scrapeCadence !== undefined ? opts.scrapeCadence : (await getScrapeState(db)).cadence;
  const { promotion, demotion } = evaluateTierEvidenceForRow(row, opts.now, { scrapeCadence: cadence });
  const { data: ledger, error: ledgerErr } = await db.from("source_reliability_ledger").select("source_id, outcome, scored_at").eq("source_id", sourceId).gte("scored_at", new Date(opts.now.getTime() - CFG.outcomeWindowDays * MS_PER_DAY).toISOString());
  const outcome = ledgerErr ? undefined : outcomeMovement(tallyOutcomes((ledger ?? []) as OutcomeRow[], opts.now).get(sourceId));
  const decision = decideEffectiveTier({
    base_tier: row.base_tier as SourceTier,
    effective_tier: row.effective_tier == null ? null : (row.effective_tier as SourceTier),
    tier_override: row.tier_override == null ? null : (row.tier_override as SourceTier),
    evidence: { citation_promote: cited.should_promote, citation_reasoning: cited.reasoning, promotion, demotion, opinion: opinionMovement(row.base_tier, (ops ?? []) as TierOpinionRow[], opts.now), outcome },
  });
  return { source_id: sourceId, decision, weighted_sum: cited.weighted_sum, citation_count: cited.citation_count, outcome_read_error: ledgerErr?.message ?? null };
}
