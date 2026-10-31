// Ported from old_repo/src/lib/detail/fact-card-model.ts (lines 41-90)
// Ported from old_repo/src/lib/detail/fact-card-model.ts (lines 480-572)
// Ported from old_repo/src/lib/agent/parse-record-sections.ts (lines 10-18)
// The fact-card prop types and the per-claim tier read. INV-126/213: a claim's tier is the caller's map (COALESCE(tier_override, base_tier)) read by the claim's ID; this module never infers a claim from its text, never derives a tier, never reads effective_tier.

export interface ClaimNode {
  text: string;
  bold?: boolean;
  /** An inline link node: `text` is the host, `href` the target. */
  href?: string | null;
}
export interface FactCardProvenance {
  tier?: number | null;
  source?: string | null;
  org?: string | null;
  href?: string | null;
  accessed?: string | null;
}
export interface FactCardModel {
  kind: string;
  qualifier?: string | null;
  figureLead?: string | null;
  figureSubLabel?: string | null;
  claim: ClaimNode[];
  provenance?: FactCardProvenance | null;
  /** The grounded claim this card states (section_claim_provenance.id); its tier is read from the claim map by this id. A card with no id draws no tier. */
  claimId?: string | null;
  /** A merged card: every later same-kind claim of the run, each its own paragraph, claim id and provenance line. */
  additionalClaims?: { claim: ClaimNode[]; claimId?: string | null; provenance?: FactCardProvenance | null }[];
  /** A record-grade card: its tier arrives with the row, so the claim map leaves it alone. */
  recordGrade?: boolean;
}
/** The operations matrix density, already resolved by the operations feature (the kit does no region-grid arithmetic). */
export interface MatrixFact {
  figure: string | null;
  /** The label or the first six words when there is no figure. */
  headline: string;
  /** The claim sentence drawn inline after the figure or headline. */
  claim: string;
  prose: string | null;
  indexVsBase: number | null;
  /** The two "Why this matters" lines under the figure; empty when none was read. */
  why?: readonly string[] | undefined;
  sourceName: string | null;
  sourceUrl: string | null;
  sourceTier: number | null;
  period: string | null;
  /** The provenance words ("Official · derived"), or empty. */
  provenance: string;
  /** The row-written date (YYYY-MM-DD), or null. */
  written: string | null;
}

export interface ClaimTierInfo {
  tier: number | null;
  sourceName: string | null;
  sourceUrl: string | null;
  /** The claim's own text, for the record-grade line match (core/brief parseRecordSections); the tier of a card is never read from it. */
  text?: string;
}
/** The surface's claims by claim id. */
export type ClaimTierMap = Record<string, ClaimTierInfo>;

/** The tier of the claim a card names, read from its row: no id, or an id the map does not hold, or a claim with no rated source, leaves the provenance as it was. */
function withTier(claimId: string | null | undefined, provenance: FactCardProvenance | null | undefined, claimTiers: ClaimTierMap): FactCardProvenance | null {
  if (typeof provenance?.tier === "number") return provenance;
  const info = claimId ? claimTiers[claimId] : undefined;
  return info && typeof info.tier === "number" ? { source: provenance?.source ?? info.sourceName ?? null, org: provenance?.org ?? null, href: provenance?.href ?? info.sourceUrl ?? null, accessed: provenance?.accessed ?? null, tier: info.tier } : (provenance ?? null);
}

/** Attach each claim's grounded-source tier to a card model by its claim id; inference and record-grade cards are returned untouched. Pure. */
export function withClaimTiers(model: FactCardModel, claimTiers: ClaimTierMap | null | undefined): FactCardModel {
  if (!claimTiers || model.kind === "ANALYTICAL INFERENCE" || model.recordGrade) return model;
  return {
    ...model,
    provenance: withTier(model.claimId, model.provenance, claimTiers),
    ...(model.additionalClaims ? { additionalClaims: model.additionalClaims.map((c) => ({ ...c, provenance: withTier(c.claimId, c.provenance, claimTiers) })) } : {}),
  };
}

export const sixWordHeadline = (text: string, n = 6): string => String(text).trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");

// A source name past this many characters wraps to two lines in the provenance column, so the org line is dropped (a width heuristic, 5 px a character).
export const sourceNameWrapsToTwoLines = (source: string | null | undefined): boolean => !!source && source.length * 5 > 109;
