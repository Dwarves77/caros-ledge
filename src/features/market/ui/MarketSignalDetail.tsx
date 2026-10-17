// Ported from old_repo/src/components/pages/MarketSignalDetailSurface.tsx (lines 1-873)
// The market signal's detail body (spec 02 row 12): the promotion state, the price board and the ratified series figure each with freshness and the rating of its source (INV-262), the carbon blocks, related signals. A pure view of
// MarketDetailBundle; each part is its own Section so one failed read is that part's note with Retry. The route wraps this in P2-10's detail architecture (loadDetail + DetailLayout); this body does not draw the masthead.
import Link from "next/link";

import { DerivedFigure } from "@/ui/figures";
import { SectionCard } from "@/ui/SectionCard";
import { SectionHead } from "@/ui/SectionHead";

import { buildCarbonCostPerFeuView, buildCarbonOverlayView, intensityFigure, selectFactor } from "../lib/carbon";
import { deriveSeriesFreshness } from "../lib/freshness";
import { envelopeFromPriceStat, envelopeFromSeriesRow, ratingText } from "../lib/provenance";
import { prefixOf, producerFor } from "../lib/registry";
import { derivePromotionState } from "../lib/signal-promotion";
import type { MarketDetailBundle } from "../read";

import { CarbonCostOverlay } from "./CarbonCostOverlay";
import { ProvenanceDrawer } from "./Provenance";
import { RetryNote } from "./RetryNote";
import { FreshnessBadge } from "./SeriesFreshness";
import { TrajectoryBars, type TrajectoryPoints } from "./TrajectoryBars";
import styles from "./market.module.css";

export interface MarketSignalDetailProps {
  bundle: MarketDetailBundle;
  item: { jurisdictionIso: readonly string[]; modes: readonly string[]; originClass: string | null };
  nowIso: string;
  trajectory?: TrajectoryPoints | null;
}

export function MarketSignalDetail({ bundle, item, nowIso, trajectory = null }: MarketSignalDetailProps) {
  const { convergence, priceBoard, seriesFigure, carbon, related } = bundle;
  const promotion = derivePromotionState({ originClass: item.originClass, independentCiters: convergence.ok ? (convergence.data?.independent_citers ?? null) : null });
  const now = new Date(nowIso);
  return (
    <div data-audit="market-detail" className={styles.band}>
      <p data-audit="promotion-state" data-promotion={promotion.code} className={styles.muted}>
        {promotion.chip}
        {promotion.independentCiters ? ` · ${promotion.independentCiters} independent sources` : ""}
      </p>
      <SectionCard>
        <SectionHead title="Price board" />
        {!priceBoard.ok ? (
          <RetryNote what="The price board" />
        ) : priceBoard.data.length === 0 ? (
          <p className={styles.muted}>No published price statistics are attached to this signal.</p>
        ) : (
          <ul className={styles.gapList}>
            {priceBoard.data.map((p) => (
              <li key={p.label} data-audit="price-stat">
                <b>{p.valueDisplay}</b> {p.unit ?? ""} · {p.label}
                <span className={styles.muted}> · {ratingText(envelopeFromPriceStat(p, seriesFigure.ok ? (seriesFigure.data?.rating ?? null) : null).sourceTier)}{p.releasedAt ? ` · released ${p.releasedAt}` : ""}</span>
                {p.nextReleaseAt ? <span className={styles.muted}> · next {p.nextReleaseLabel ?? p.nextReleaseAt}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      {!seriesFigure.ok ? (
        <RetryNote what="The series figure" />
      ) : seriesFigure.data ? (
        <SectionCard>
          <SectionHead title={seriesFigure.data.row.label} />
          <p data-audit="series-figure">
            <b>{seriesFigure.data.row.displayValue}</b> <span className={styles.muted}>{seriesFigure.data.row.unit ?? ""} · {ratingText(seriesFigure.data.rating?.tier)}</span>
          </p>
          <FreshnessBadge freshness={deriveSeriesFreshness({ as_at_date: seriesFigure.data.row.asAtDate, reference_period: seriesFigure.data.row.referencePeriod }, { cadenceDays: seriesFigure.data.cadenceDays }, nowIso)} />
          <ProvenanceDrawer envelope={envelopeFromSeriesRow(seriesFigure.data.row, producerFor(prefixOf(seriesFigure.data.row.seriesKey)) ?? null, seriesFigure.data.rating)} />
          {trajectory ? <TrajectoryBars trajectoryPoints={trajectory} /> : null}
        </SectionCard>
      ) : null}
      {!carbon.ok ? (
        <RetryNote what="Carbon intensity" />
      ) : (
        <CarbonBlocks carbon={carbon.data} item={item} now={now} nowIso={nowIso} />
      )}
      {!related.ok ? (
        <RetryNote what="Related signals" />
      ) : related.data.length > 0 ? (
        <SectionCard>
          <SectionHead title="Related signals" />
          <ul className={styles.gapList}>
            {related.data.slice(0, 6).map((r) => (
              <li key={r.id}>
                <Link href={`/market/${r.id}`}>{r.title}</Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}

function CarbonBlocks({ carbon, item, now, nowIso }: { carbon: Extract<MarketDetailBundle["carbon"], { ok: true }>["data"]; item: MarketSignalDetailProps["item"]; now: Date; nowIso: string }) {
  const overlay = buildCarbonOverlayView({ jurisdictionIso: item.jurisdictionIso, factors: carbon.factors, mode: item.modes.length === 1 ? (item.modes[0] ?? null) : null });
  const sel = selectFactor(carbon.factors, { mode: item.modes.length === 1 ? (item.modes[0] ?? null) : null, jurisdictionIso: item.jurisdictionIso });
  const figure = sel.state === "resolved" ? intensityFigure(sel.factor, nowIso) : null;
  const rating = sel.state === "resolved" && sel.factor.source_key ? (carbon.ratings[sel.factor.source_key] ?? null) : null;
  const perFeu = buildCarbonCostPerFeuView({ jurisdictionIso: item.jurisdictionIso, modes: item.modes, factors: carbon.factors, corridorCandidates: carbon.corridorCandidates });
  return (
    <>
      <SectionCard>
        <SectionHead title={overlay.header} />
        <p className={styles.muted}>{overlay.body}</p>
        {figure ? <DerivedFigure figure={figure} label="Emission intensity" now={now} rating={ratingText(rating?.tier)} /> : null}
      </SectionCard>
      {perFeu?.result ? <CarbonCostOverlay overlays={[{ label: perFeu.label ?? "", corridor: perFeu.result.corridor, entityId: "detail", jurisdictions: [], result: perFeu.result }]} /> : perFeu?.body ? <p className={styles.muted}>{perFeu.body}</p> : null}
    </>
  );
}
