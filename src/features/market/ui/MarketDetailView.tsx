"use client";

// Ported from old_repo/src/components/pages/MarketSignalDetailSurface.tsx (lines 1-873)
// The /market/[slug] frame on the detail architecture (P2-10): the masthead, the rail, the stored fact sections of the item, the market blocks (MarketSignalDetail) and the cross-page analysis. The loader's degraded blocks (claims
// that did not load, a refused market read) are said where they sit with Retry; nothing here reads the clock or a table.
import { useRouter } from "next/navigation";

import { SECTION_INDEX } from "@/core/detail/section-index";
import type { SectionRow } from "@/core/detail/item-read";
import { bandFromPriority } from "@/core/lists";
import type { ConnectionRow } from "@/core/flywheel";
import type { RecommendedAction } from "@/core/brief";
import type { Resource } from "@/core/types";
import { Absence, ClaimTierProvider, StateNote, type ClaimTierMap } from "@/ui";
import { AtAGlanceCard, CrossPageSection, DetailLayout, DetailMasthead, DetailPageWrapper, DetailRail, DetailSection, FactBlocks, InThisListStat, ItemConnections, ItemWatch, topRecommendedAction, type CrossPageData } from "@/ui/detail";
import { LegendRailCard } from "@/ui/list-surface";

import type { MarketDetailBundle } from "../read";

import { MarketSignalDetail } from "./MarketSignalDetail";

export interface MarketDetailViewProps {
  resource: Resource;
  sections: SectionRow[];
  claimTiers: ClaimTierMap;
  claimsDegraded: boolean;
  recommendedActions: RecommendedAction[];
  crossPage: CrossPageData;
  connectionRows: ConnectionRow[];
  bundle: MarketDetailBundle;
  nowIso: string;
}

export function MarketDetailView({ resource: r, sections, claimTiers, claimsDegraded, recommendedActions, crossPage, connectionRows, bundle, nowIso }: MarketDetailViewProps) {
  const router = useRouter();
  const band = bandFromPriority(r.priority);
  const stored = SECTION_INDEX.flatMap((e) => (e.key ? sections.filter((s) => s.section_key === e.key && (s.content_md || "").trim()).map((s) => ({ e, s })) : []));
  return (
    <ClaimTierProvider claimTiers={claimTiers}>
      <div style={{ paddingTop: 16 }}>
        <DetailPageWrapper band={band} action={topRecommendedAction(recommendedActions)} nowIso={nowIso}>
          <DetailMasthead title={r.title} band={band} surface="Market Intel" {...(r.jurisdiction ? { jurisdiction: r.jurisdiction } : {})} dek={r.note || undefined} placeholder="Ask about this signal, e.g. what moved and what it costs" nowIso={nowIso} actionSlot={<ItemWatch itemId={r.id} />} connectionsSlot={connectionRows.length > 0 ? <ItemConnections rows={connectionRows} /> : undefined} />
          {claimsDegraded && (
            <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>
              The facts of this signal did not load, so none is shown. Nothing was changed; try again.
            </StateNote>
          )}
          <DetailLayout
            rail={
              <DetailRail
                atAGlance={<AtAGlanceCard rows={[{ label: "Topic", value: r.topic }, { label: "Signal kind", value: r.severity ?? null }, { label: "Source rating", value: typeof r.sourceTier === "number" ? `T${r.sourceTier}` : null }]} />}
                designed={<InThisListStat backHref="/market" backLabel="Back to list" band={band} />}
                legend={<LegendRailCard />}
              />
            }
          >
            <DetailSection id="summary" title="Summary" aside="Generated · 30-second read" index={1}>
              {r.whatIsIt || r.whyMatters ? (
                <>
                  {r.whatIsIt ? <p>{r.whatIsIt}</p> : null}
                  {r.whyMatters ? <p>{r.whyMatters}</p> : null}
                </>
              ) : (
                <Absence reason="not in primary source" />
              )}
            </DetailSection>
            <MarketSignalDetail bundle={bundle} item={{ jurisdictionIso: r.jurisdictionIso ?? [], modes: r.modes ?? [], originClass: null }} nowIso={nowIso} />
            {!claimsDegraded &&
              stored.map(({ e, s }) => (
                <DetailSection key={s.id} id={e.id} title={e.shortName} index={e.ord ?? null}>
                  <FactBlocks markdown={s.content_md} />
                </DetailSection>
              ))}
            <CrossPageSection surfaceKey="market" surfaceLabel="Market Intel" crossPage={crossPage} onRetry={() => router.refresh()} />
          </DetailLayout>
        </DetailPageWrapper>
      </div>
    </ClaimTierProvider>
  );
}
