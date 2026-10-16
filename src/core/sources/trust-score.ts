// Ported from old_repo/src/lib/trust.ts (lines 14-187)
// Ported from old_repo/src/lib/trust.ts (lines 1129-1264)
import movement from "./data/tier-movement.json";
import { TIER_WEIGHTS } from "./tier-contract";
import type { SourceTier, TrustMetrics, TrustScore } from "./types";

/** The columns the trust and tier calculators read from a sources row. */
export interface TierSourceRow {
  id: string;
  name?: string | null;
  base_tier: number;
  effective_tier: number | null;
  tier_override: number | null;
  status?: string | null;
  /** A source intentionally on hold keeps its last-known tier and score: it is read (it still weighs as a citer) but never moved. */
  processing_paused?: boolean | null;
  confirmation_count: number | null;
  conflict_count: number | null;
  accuracy_rate: number | null;
  accessibility_rate: number | null;
  total_checks: number | null;
  lead_time_samples: number | null;
  avg_lead_time_days: number | null;
  independent_citers: number | null;
  highest_citing_tier: number | null;
  total_citations: number | null;
  self_citation_count: number | null;
  conflict_total: number | null;
  last_checked: string | null;
  last_accessible: string | null;
  created_at: string;
  last_substantive_change: string | null;
  update_frequency: string | null;
}
export const TIER_SOURCE_COLUMNS =
  "id, name, base_tier, effective_tier, tier_override, status, processing_paused, confirmation_count, conflict_count, accuracy_rate, accessibility_rate, total_checks, lead_time_samples, avg_lead_time_days, independent_citers, highest_citing_tier, total_citations, self_citation_count, conflict_total, last_checked, last_accessible, created_at, last_substantive_change, update_frequency";

/** TrustMetrics from the flat sources columns; a field not on the row defaults to 0 or null. */
export function trustMetricsFromRow(s: TierSourceRow): TrustMetrics {
  return {
    confirmation_count: s.confirmation_count || 0,
    conflict_count: s.conflict_count || 0,
    conflict_total: s.conflict_total || 0,
    accuracy_rate: s.accuracy_rate ?? 0,
    total_checks: s.total_checks || 0,
    successful_checks: 0,
    consecutive_accessible: 0,
    accessibility_rate: s.accessibility_rate ?? 0,
    last_accessible: s.last_accessible ?? null,
    last_inaccessible: null,
    lead_time_samples: s.lead_time_samples || 0,
    avg_lead_time_days: s.avg_lead_time_days || 0,
    independent_citers: s.independent_citers || 0,
    total_citations: s.total_citations || 0,
    self_citation_count: s.self_citation_count || 0,
    highest_citing_tier: (s.highest_citing_tier || null) as SourceTier | null,
  };
}

// Weights: accuracy 40, timeliness 20, reliability 20, citation 20. A source with no earned data scores a neutral 40; the tier prior (blended
// in below) separates a tier-1 gazette from a provisional tier-7 candidate until earned data takes over.
const accuracy = (m: TrustMetrics): number => {
  const MAX = 40;
  const total = m.confirmation_count + m.conflict_count;
  if (total < 1) return MAX * 0.5;
  const rate = m.confirmation_count / total;
  return rate < 0.5 ? MAX * rate : MAX * 0.5 + MAX * 0.5 * Math.sqrt((rate - 0.5) * 2);
};
const timeliness = (m: TrustMetrics): number => {
  const MAX = 20;
  if (m.lead_time_samples < 2) return MAX * 0.5;
  const lead = m.avg_lead_time_days;
  if (lead < 0) return MAX * Math.max(0.1, 0.5 + lead / 60);
  if (lead === 0) return MAX * 0.5;
  return MAX * 0.5 + MAX * 0.5 * Math.sqrt(Math.min(1, lead / 90));
};
const reliability = (m: TrustMetrics): number => {
  const MAX = 20;
  if (m.total_checks < 3) return MAX * 0.5;
  const rate = m.accessibility_rate;
  return rate < 0.5 ? MAX * rate : MAX * 0.5 + MAX * 0.5 * Math.pow((rate - 0.5) * 2, 0.7);
};
/** The citation component (0-20): independent citers, weighted by the best citing tier. */
export const computeCitationComponent = (m: TrustMetrics): number => {
  if (m.independent_citers === 0) return 0;
  const weight = m.highest_citing_tier ? (TIER_WEIGHTS[m.highest_citing_tier] ?? 0) : 0;
  return 20 * Math.sqrt(Math.min(1, m.independent_citers / 10)) * weight;
};

export const tierPrior = (tier: number): number => (movement.tierPriors as Record<string, number>)[String(tier)] ?? 25;

/** The earned score (0-100): the sum of the four weighted components. */
export function computeEarnedScore(m: TrustMetrics): number {
  return Math.round(accuracy(m) + timeliness(m) + reliability(m) + computeCitationComponent(m));
}
/** overall = prior_weight x tier_prior + (1 - prior_weight) x earned, prior_weight = max(0, 1 - signals / 10): a tier prior at zero signals, earned data from ten. */
export function computeOverallScore(m: TrustMetrics, tier: number): number {
  const signals = (m.independent_citers || 0) + (m.total_checks || 0) + (m.confirmation_count || 0) + (m.conflict_count || 0);
  const priorWeight = Math.max(0, 1 - signals / 10);
  return Math.round(priorWeight * tierPrior(tier) + (1 - priorWeight) * computeEarnedScore(m));
}

const r1 = (n: number): number => Math.round(n * 10) / 10;
/**
 * The score with stored components that ADD UP to the stored overall. The blended overall differs from the earned sum, so the four earned
 * components are scaled to the overall and the one-decimal residue lands on the accuracy component (a stored 85 with components summing to 40 was the defect).
 */
export function computeTrustScore(m: TrustMetrics, tier: number, computedAt: string): TrustScore {
  const overall = computeOverallScore(m, tier);
  const raw = [accuracy(m), timeliness(m), reliability(m), computeCitationComponent(m)];
  const sum = raw.reduce((a, b) => a + b, 0);
  const scaled = sum > 0 ? raw.map((c) => r1((c * overall) / sum)) : [overall, 0, 0, 0];
  scaled[0] = r1((scaled[0] ?? 0) + (overall - scaled.reduce((a, b) => a + b, 0)));
  return { overall, accuracy_component: scaled[0] ?? 0, timeliness_component: scaled[1] ?? 0, reliability_component: scaled[2] ?? 0, citation_component: scaled[3] ?? 0, computed_at: computedAt };
}

export interface TrustScorePatch {
  trust_score_overall: number;
  trust_score_accuracy: number;
  trust_score_timeliness: number;
  trust_score_reliability: number;
  trust_score_citation: number;
  trust_score_computed_at: string;
}
export interface TrustScoreRow {
  id: string;
  name: string | null;
  base_tier: number;
  overall: number;
  patch: TrustScorePatch;
}

/**
 * The trust-score pass as a pure plan: for every source not on a per-source hold, the score anchored to base_tier and the column patch to apply,
 * plus the distribution and per-tier averages. Writes nothing; never a tier column (effective_tier has its own guarded writer).
 */
export function planTrustScores(sources: TierSourceRow[], computedAtIso: string) {
  const rows: TrustScoreRow[] = [];
  const distribution = { "0-20": 0, "21-40": 0, "41-60": 0, "61-80": 0, "81-100": 0 };
  const byTier: Record<number, number[]> = {};
  let skipped_paused = 0;
  for (const s of sources) {
    if (s.processing_paused) {
      skipped_paused++;
      continue;
    }
    const score = computeTrustScore(trustMetricsFromRow(s), s.base_tier, computedAtIso);
    rows.push({ id: s.id, name: s.name ?? null, base_tier: s.base_tier, overall: score.overall, patch: { trust_score_overall: score.overall, trust_score_accuracy: score.accuracy_component, trust_score_timeliness: score.timeliness_component, trust_score_reliability: score.reliability_component, trust_score_citation: score.citation_component, trust_score_computed_at: computedAtIso } });
    const bucket = score.overall <= 20 ? "0-20" : score.overall <= 40 ? "21-40" : score.overall <= 60 ? "41-60" : score.overall <= 80 ? "61-80" : "81-100";
    distribution[bucket]++;
    (byTier[s.base_tier] ??= []).push(score.overall);
  }
  const tier_averages: Record<string, { n: number; avg: number; min: number; max: number }> = {};
  for (const [t, arr] of Object.entries(byTier)) tier_averages[`T${t}`] = { n: arr.length, avg: r1(arr.reduce((a, b) => a + b, 0) / arr.length), min: Math.min(...arr), max: Math.max(...arr) };
  return { rows, distribution, tier_averages, skipped_paused };
}
