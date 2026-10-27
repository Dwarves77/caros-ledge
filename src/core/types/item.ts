// Ported from old_repo/src/types/resource.ts (lines 1-311)
// The shared item type every surface imports. TabId, FocusView, NavEntry and Cluster are not carried over (no importer).

export interface TimelineEntry {
  date: string;
  label: string;
  status?: "past" | "current" | "future" | undefined;
  detail?: string | undefined;
  claimId?: string | null | undefined;
  sectionId?: string | null | undefined;
  kind?: string | undefined;
}

export interface ImpactScores {
  /** Each 0-3. */
  cost: number;
  compliance: number;
  client: number;
  operational: number;
}

export interface ImpactReasoning {
  cost?: string;
  compliance?: string;
  client?: string;
  operational?: string;
}

export interface Dispute {
  resource: string;
  note: string;
  sources: { name: string; url: string }[];
}

export interface ChangeLogEntry {
  id: string;
  date: string;
  type: "NEW" | "UPDATED";
  fields?: string[];
  prev?: string;
  now?: string;
  impact?: string;
}

export interface Supersession {
  old: string;
  new: string;
  date: string;
  severity: "major" | "minor" | "replacement";
  note: string;
}

/** One item_cross_references row from the OTHER item's point of view; `surface` is pre-resolved so the card needs no routing rules. */
export interface ItemConnection {
  id: string;
  direction: "outgoing" | "incoming";
  relationship: string;
  origin: string;
  basis: Array<{ signal: string; detail: string; weight: number }> | null;
  score: number | null;
  surface: string;
}

export interface OperationalImpact {
  /** "ocean", "air", "road", "customs", "reporting", "procurement". */
  mode: string;
  /** "contracts", "pricing", "compliance", "data", "operations". */
  function: string;
  impact: string;
  severity: "low" | "medium" | "high";
}

export interface RiskRegisterEntry {
  risk: string;
  severity: "low" | "medium" | "high";
  likelihood: "low" | "medium" | "high";
  deadline?: string;
}

export interface RecommendedAction {
  action: string;
  owner: string;
  timeframe: string;
  /** 1 = highest priority. */
  priority: number;
}

export interface SourceReference {
  name: string;
  url: string;
  /** 1-5. */
  tier?: number;
  type?: "primary_text" | "official_guidance" | "intergovernmental" | "expert_analysis" | "industry";
}

export interface BiasTag {
  dimension: "funding" | "methodology" | "stakeholder";
  tag: string;
  confidence: number | null;
}

export interface Resource {
  /** The display id: the legacy id when the item has one, else the uuid. Routes and links use it; identity checks do not. */
  id: string;
  /** The item's uuid (intelligence_items.id), always. The detail root states it as data-item-id. */
  itemUuid?: string;
  /** Primary mode: ocean, air, road. */
  cat: string;
  sub: string;
  title: string;
  url: string;
  /** Status and action summary (card preview). */
  note: string;
  /** framework, regulation, law, standard, innovation, etc. */
  type: string;
  priority: "CRITICAL" | "HIGH" | "MODERATE" | "LOW";
  /** ISO date. */
  added: string;
  reasoning: string;
  tags: string[];
  whatIsIt: string;
  whyMatters: string;
  keyData: string[];
  timeline?: TimelineEntry[];

  operationalImpact?: OperationalImpact[];
  riskRegister?: RiskRegisterEntry[];
  recommendedActions?: RecommendedAction[];
  openQuestions?: string[];
  sourceUrls?: SourceReference[];
  /** The full intelligence brief (markdown): the primary content field; whatIsIt, whyMatters and keyData are card previews. */
  fullBrief?: string;

  /** 1 regulatory, 2 tech, 3 regional, 4 market, 5 sources, 6 facility, 7 research. */
  domain?: number;

  modes?: string[];
  topic?: string;
  jurisdiction?: string;

  severity?: string;
  signalBand?: "price" | "corporate" | "corridor";
  theme?: string;
  /** Price time series; non-null only when signalBand is "price" (a DB CHECK). */
  trajectoryPoints?: { points: Array<{ date: string; value: number }>; base_date: string; base_label: string };

  whatItChanges?: string;
  doesNotResolve?: string;
  conversionTrigger?: string;
  crossReferences?: string;

  /** ISO 3166-1/-2 and supranational codes; preferred over the legacy single `jurisdiction`. */
  jurisdictionIso?: string[];
  subJurisdiction?: string;
  subJurisdictionLabel?: string;

  regulatoryConflict?: {
    type: "federal-state" | "international" | "trade" | "supersession" | "divergence";
    summary: string;
    parties: string[];
    status: "active" | "pending" | "resolved";
  };

  authorityLevel?: "primary_text" | "official_guidance" | "intergovernmental" | "expert_analysis" | "unconfirmed";
  sourceId?: string;
  sourceUrl?: string;
  sourceName?: string;
  sourceTier?: number;
  lastRegeneratedAt?: string | null;
  /** "record" = extracted fact spans only, no synthesized brief; absent where the owning read does not project it. */
  itemGrade?: "record" | "brief";
  /** Provenance-envelope origin class (community, community-corroborated, modelled, derived, partner, verified, official). */
  originClass?: string | null;
  legalInstrument?: string;
  enforcementBody?: string;
  penaltyRange?: string;
  complianceDeadline?: string;
  costMechanism?: string;
  actionOwner?: string;
  lastVerifiedDate?: string;
  /** The instrument's per-year requirement path; a step's `date` is free-form, not guaranteed ISO. */
  requirementTrajectory?: { steps: Array<{ date: string; value: string; label?: string }>; note?: string };
  /** The Market list key figure; null or absent means "no price dimension" and renders the honest em-dash. */
  priceStat?: { label: string; valueDisplay: string; unit?: string | null; releasedAt?: string | null } | null;

  category?: string;
  lifecycleStage?: string;
  provenanceLevel?: string;
  lastVerified?: string;

  isArchived?: boolean;
  archiveReason?: string;
  archiveNote?: string;
  archivedDate?: string;
  replacedBy?: string;

  urgencyScore?: number;
  impactScores?: ImpactScores;
  /** The sentence of the first input the impact score is still waiting for (set when impactScores is not): the row names what it needs. */
  impactAbsence?: string;
  impactReasoning?: ImpactReasoning;

  agentIntegrityFlag?: boolean;
  agentIntegrityPhrase?: string | null;
  agentIntegrityFlaggedAt?: string | null;

  citationCount?: number | null;
  lastCitedAt?: string | null;
  /** Empty array once enrichment ran and the source has no tags; undefined where enrichment was not run. */
  biasTags?: BiasTag[];
  /** Registered sources the item cites, each with its customer tier and bias tags (detail read only). */
  citedSources?: Array<{ url: string; tier: number | null; biasTags: BiasTag[] }>;
}
