// Ported from old_repo/src/lib/sources/promote-provisional.ts (lines 1-104)
import { canonicalUrl } from "@/core/shared";
import { classifySourceRole } from "@/core/sources/classify";

export const PROVISIONAL_PROMOTED_STATUS = "promoted";
export const PROVISIONAL_REJECTED_STATUS = "rejected";

export interface ProvisionalRowInput {
  name: string;
  url: string;
  description?: string | null;
  discovered_via?: string | null;
}
export interface PromotedSourceRow {
  name: string;
  url: string;
  source_role: string | null;
  description: string;
  base_tier: number;
  effective_tier: number;
  tier_at_creation: number;
  domains: number[];
  jurisdictions: string[];
  transport_modes: string[];
  topic_tags: string[];
  access_method: string;
  status: string;
  update_frequency: string;
  intelligence_types: string[];
  vertical_tags: string[];
  notes: string;
}

/**
 * The provisional-to-active row builder. `tier` is caller-decided (a class-table tier or an operator ruling): never guessed here. The URL is stored as given
 * (trimmed); identity is compared through the one canonicaliser, so a case-sensitive path is never rewritten.
 */
export function buildPromotedSourceRow(prov: ProvisionalRowInput, tier: number, opts: { promotedBy: string; note?: string; nowIso: string }): PromotedSourceRow {
  if (!Number.isInteger(tier) || tier < 1 || tier > 7) throw new Error(`buildPromotedSourceRow: ${tier} is not a tier`);
  const url = prov.url.trim();
  return {
    name: prov.name,
    url,
    source_role: classifySourceRole(prov.name, url),
    description: prov.description || "",
    base_tier: tier,
    effective_tier: tier,
    tier_at_creation: tier,
    domains: [],
    jurisdictions: [],
    transport_modes: [],
    topic_tags: [],
    access_method: "scrape",
    status: "active",
    update_frequency: "weekly",
    intelligence_types: [],
    vertical_tags: [],
    notes: `Promoted from provisional ${opts.nowIso.slice(0, 10)} by ${opts.promotedBy}. Discovered via ${prov.discovered_via ?? "unknown"}. ${opts.note || ""}`.trim(),
  };
}

/** The dedup guard: promoting the same provisional twice, or a URL another path already registered, reuses the existing row. `hostMatches` is the caller's host-narrowed set; the compare is canonical, never a raw eq. */
export function findExistingSourceByCanonicalUrl<T extends { url: string | null }>(hostMatches: readonly T[] | null | undefined, url: string): T | null {
  const want = canonicalUrl(url);
  return (hostMatches ?? []).find((s) => canonicalUrl(s.url) === want) ?? null;
}
