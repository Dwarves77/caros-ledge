// Ported from old_repo/src/lib/detail/fact-card-model.ts (lines 41-90, 480-572)
// Ported from old_repo/src/lib/agent/parse-record-sections.ts (lines 10-18)
// The fact-card prop types and the per-claim tier match. INV-126/213: a claim's tier is the caller's map (COALESCE(tier_override, base_tier)); this module only matches, never derives, never reads effective_tier.

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
  /** A merged card: every later same-kind claim of the run, each its own paragraph and provenance line. */
  additionalClaims?: { claim: ClaimNode[]; provenance?: FactCardProvenance | null }[];
  /** A record-grade card: its tier is matched by the exact claim line upstream, so the containment match leaves it alone. */
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
}
export type ClaimTierMap = Record<string, ClaimTierInfo>;

const MIN_CONTAINED = 24;
const DASHES = String.fromCharCode(0x2014, 0x2013, 0x2d);
const FACT_LABEL_RE = new RegExp(`^(?:[^:\\n]{0,120}?\\s+[${DASHES}]\\s+)?fact:\\s*`, "i");
const SLOT_PREFIX_RE = /^\[[a-z0-9_]+\]\s*/i;
const QUOTE_EDGE_RE = /^["'“”‘’]+|["'“”‘’]+$/g;

/** Slot prefix, FACT label, emphasis markers, edge quotes and whitespace runs removed; lower-cased. */
export const normalizeClaimText = (raw: string): string =>
  String(raw ?? "").replace(/\*+/g, "").trim().replace(SLOT_PREFIX_RE, "").replace(FACT_LABEL_RE, "").replace(QUOTE_EDGE_RE, "").replace(/\s+/g, " ").trim().toLowerCase();

function claimsMatch(card: string, entry: string): boolean {
  if (!card || !entry) return false;
  if (card === entry) return true;
  const [short, long] = card.length <= entry.length ? [card, entry] : [entry, card];
  return short.length >= MIN_CONTAINED && long.includes(short);
}

/** The one rated source a claim resolves to, or null (no match, a match with no tier, or matches that disagree: an ambiguous card gets no tier). */
export function resolveClaimTier(claimText: string, claimTiers: ClaimTierMap | null | undefined): ClaimTierInfo | null {
  const card = normalizeClaimText(claimText);
  if (!claimTiers || !card) return null;
  let found: ClaimTierInfo | null = null;
  for (const [key, info] of Object.entries(claimTiers)) {
    if (!info || typeof info.tier !== "number" || !claimsMatch(card, normalizeClaimText(key))) continue;
    if (found && (found.tier !== info.tier || (found.sourceName ?? null) !== (info.sourceName ?? null))) return null;
    found = info;
  }
  return found;
}

function withTier(nodes: ClaimNode[], provenance: FactCardProvenance | null | undefined, claimTiers: ClaimTierMap): FactCardProvenance | null | undefined {
  if (typeof provenance?.tier === "number") return provenance;
  const info = resolveClaimTier(nodes.map((n) => n.text).join(" "), claimTiers);
  return info ? { source: provenance?.source ?? info.sourceName ?? null, org: provenance?.org ?? null, href: provenance?.href ?? info.sourceUrl ?? null, accessed: provenance?.accessed ?? null, tier: info.tier } : provenance;
}

/** Attach each claim's grounded-source tier to a card model; inference and record-grade cards are returned untouched. Pure. */
export function withClaimTiers(model: FactCardModel, claimTiers: ClaimTierMap | null | undefined): FactCardModel {
  if (!claimTiers || model.kind === "ANALYTICAL INFERENCE" || model.recordGrade) return model;
  return {
    ...model,
    provenance: withTier(model.claim, model.provenance, claimTiers),
    ...(model.additionalClaims ? { additionalClaims: model.additionalClaims.map((c) => ({ claim: c.claim, provenance: withTier(c.claim, c.provenance, claimTiers) })) } : {}),
  };
}

export const sixWordHeadline = (text: string, n = 6): string => String(text).trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");

// A source name past this many characters wraps to two lines in the provenance column, so the org line is dropped (a width heuristic, 5 px a character).
export const sourceNameWrapsToTwoLines = (source: string | null | undefined): boolean => !!source && source.length * 5 > 109;
