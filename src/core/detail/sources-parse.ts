// Ported from old_repo/src/components/detail/SourcesGrid.tsx (lines 1-90)
// Ported from old_repo/src/lib/agent/extract-regulation-sections.ts (lines 358-492)
// The rows of the Sources section: the brief's section 15 table (P2-04's parser, which reads that one section and drops placeholder rows) matched to the registry. A row's rating is the
// registry's (INV-213, INV-271): the item's own source for the primary entry, a cited source matched by canonical URL for the others, never the brief's wording, never a guess.
import { parseRegulationSections, type SourceEntry } from "@/core/brief";
import { canonicalUrl } from "@/core/shared";
import type { BiasTagInput } from "@/core/sources";
import type { Resource } from "@/core/types";

export type SourceRow = SourceEntry & { biasTags?: BiasTagInput[] | null | undefined };

const TIER_PHRASE_RE = /^[[(]?\s*(?:tier\s*|T)\d\b\s*[\])]?\s*[-–—:]?\s*/i;
/** The brief's own tier wording is dropped from a row's meta once the registry's rating is drawn. */
const dropParsedTierPhrase = (meta: string): string => String(meta ?? "").split(" · ").map((seg) => seg.replace(TIER_PHRASE_RE, "").trim()).filter(Boolean).join(" · ");
const sameUrl = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && canonicalUrl(a) === canonicalUrl(b);

export function sourceEntriesOf(r: Pick<Resource, "fullBrief" | "url" | "sourceTier" | "sourceName" | "enforcementBody" | "biasTags" | "citedSources">): SourceRow[] {
  const section = r.fullBrief ? parseRegulationSections(r.fullBrief)["15"] : undefined;
  const parsed = section && section.kind === "sources_list" ? section.entries : [];
  if (parsed.length === 0) return r.url ? [{ tier: typeof r.sourceTier === "number" ? r.sourceTier : null, name: r.sourceName || r.url, meta: r.enforcementBody || "", url: r.url, biasTags: r.biasTags }] : [];
  const byUrl = parsed.findIndex((e) => sameUrl(e.url, r.url));
  const name = (r.sourceName ?? "").trim().toLowerCase();
  const primary = byUrl >= 0 ? byUrl : name ? parsed.findIndex((e) => e.name.trim().toLowerCase() === name) : -1;
  return parsed.map((e, i): SourceRow => {
    if (i === primary) return typeof r.sourceTier === "number" ? { ...e, tier: r.sourceTier, meta: dropParsedTierPhrase(e.meta), biasTags: r.biasTags } : { ...e, tier: null, meta: dropParsedTierPhrase(e.meta), biasTags: r.biasTags };
    const hit = (r.citedSources ?? []).find((c) => sameUrl(c.url, e.url));
    if (!hit) return { ...e, tier: null, meta: dropParsedTierPhrase(e.meta) };
    const biasTags = hit.biasTags.length > 0 ? hit.biasTags : undefined;
    return typeof hit.tier === "number" ? { ...e, tier: hit.tier, meta: dropParsedTierPhrase(e.meta), biasTags } : { ...e, tier: null, meta: dropParsedTierPhrase(e.meta), biasTags };
  });
}
