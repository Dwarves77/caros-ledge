// Ported from old_repo/src/types/source.ts (lines 1-1)
// Ported from old_repo/src/types/source.ts (lines 57-97)
// Ported from old_repo/src/types/source.ts (lines 238-406)
// Ported from old_repo/src/types/source.ts (lines 411-411)
// Ported from old_repo/src/types/source.ts (lines 448-456)
// Ported from old_repo/src/types/source.ts (lines 464-464)
// Ported from old_repo/src/types/source.ts (lines 484-588)
export type SourceTier = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type SourceStatus = "active" | "stale" | "inaccessible" | "provisional" | "suspended";
export type IntelligenceType = "REG" | "STD" | "RES" | "MKT" | "IND" | "SUP" | "INN" | "PTN";
/** Source-registry domain codes (sources.domains): a classification of what a source publishes, not the customer navigation. */
export type IntelligenceDomain = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** The quantitative signals that decide promotion, demotion or holding a tier. */
export interface TrustMetrics {
  confirmation_count: number;
  conflict_count: number;
  conflict_total: number;
  accuracy_rate: number;
  avg_lead_time_days: number;
  lead_time_samples: number;
  consecutive_accessible: number;
  total_checks: number;
  accessibility_rate: number;
  successful_checks: number;
  last_accessible: string | null;
  last_inaccessible: string | null;
  independent_citers: number;
  total_citations: number;
  highest_citing_tier: SourceTier | null;
  self_citation_count: number;
}

/** The computed score. The stored components add up to the stored overall (see trust-score.ts). */
export interface TrustScore {
  overall: number;
  accuracy_component: number;
  timeliness_component: number;
  reliability_component: number;
  citation_component: number;
  computed_at: string;
}

export interface PromotionCriteria {
  from_tier: SourceTier;
  to_tier: SourceTier;
  min_trust_score: number;
  min_confirmation_count: number;
  max_conflict_rate: number;
  min_independent_citers: number;
  min_accessibility_rate: number;
  min_age_days: number;
  min_lead_time_samples: number;
  additional_requirements: string;
}
export interface DemotionTrigger {
  trigger: string;
  description: string;
  condition: string;
  severity: "immediate" | "flagged";
  tiers_affected: SourceTier[];
}

export interface TierHistoryEntry {
  date: string;
  from_tier: SourceTier;
  to_tier: SourceTier;
  reason: string;
  trust_score_at_change: number;
  changed_by: "system" | "human";
}

/** A source as the registry and the admin surfaces hold it. */
export interface Source {
  id: string;
  name: string;
  url: string;
  description: string;
  base_tier: SourceTier;
  effective_tier: SourceTier | null;
  tier_override?: SourceTier | null;
  tier_at_creation: SourceTier;
  intelligence_types: IntelligenceType[];
  domains: IntelligenceDomain[];
  jurisdictions: string[];
  jurisdiction_iso?: string[];
  transport_modes: string[];
  update_frequency: string;
  last_checked: string | null;
  last_substantive_change: string | null;
  next_scheduled_check: string | null;
  status: SourceStatus;
  paywalled: boolean;
  access_method: "api" | "rss" | "html_scrape" | "scrape" | "gazette" | "manual";
  api_endpoint?: string;
  rss_feed_url?: string;
  trust_metrics: TrustMetrics;
  trust_score: TrustScore;
  tier_history: TierHistoryEntry[];
  cited_by: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

/** A source found by citation that has not been promoted yet. */
export interface ProvisionalSource {
  id: string;
  name: string;
  url: string;
  domain: IntelligenceDomain | null;
  description: string;
  discovered_via: "skill_recommendation" | "citation_detection" | "worker_search" | "manual_add";
  provisional_tier: SourceTier;
  recommended_tier: SourceTier | null;
  status: "pending_review" | "confirmed" | "rejected" | "needs_more_data" | "promoted";
  reviewer_notes: string;
  created_at: string;
  reviewed_at: string | null;
}
