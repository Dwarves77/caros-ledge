// Ported from old_repo/src/components/pages/MarketSignalDetailSurface.tsx (lines 757-873)
// The market signal's detail blocks (spec 02 row 12): the price board and the ratified series figure each with freshness and the rating of their source (INV-262), and the carbon blocks. Pure views of MarketDetailBundle; each part
// is its own Section, so one failed read is that part's note with Retry. MarketDetailView places them in the detail page's sections.
import { formatDate } from "@/core/shared";
import { DerivedFigure } from "@/ui/figures";
import { DetailSubSection } from "@/ui/ItemGroup";

import { buildCarbonCostPerFeuView, buildCarbonOverlayView, intensityFigure, selectFactor } from "../lib/carbon";
import { deriveSeriesFreshness } from "../lib/freshness";
import { envelopeFromPriceStat, envelopeFromSeriesRow, ratingText } from "../lib/provenance";
import { prefixOf, producerFor } from "../lib/registry";
import type { MarketDetailBundle } from "../read";

import { CarbonCostOverlay } from "./CarbonCostOverlay";
import { ProvenanceDrawer } from "./Provenance";
import { RetryNote } from "./RetryNote";
import { FreshnessBadge } from "./SeriesFreshness";
import styles from "./market.module.css";

export interface MarketBlockProps {
  bundle: MarketDetailBundle;
  nowIso: string;
}

/** The price board, each statistic with its rating (stored, else its series') and release date, and the ratified series figure under it. */
export function PriceBoardBlock({ bundle, nowIso }: MarketBlockProps) {
  const { priceBoard, seriesFigure } = bundle;
  return (
    <>
      {!priceBoard.ok ? (
        <RetryNote what="The price board" />
      ) : priceBoard.data.length === 0 ? null : (
        <ul data-audit="price-board" className={styles.gapList}>
          {priceBoard.data.map((p) => (
            <li key={p.label} data-audit="price-stat">
              <b>{p.valueDisplay}</b> {p.unit ?? ""} · {p.label}
              <span className={styles.muted}>
                {" "}
                · {ratingText(envelopeFromPriceStat(p, seriesFigure.ok ? (seriesFigure.data?.rating ?? null) : null).sourceTier)}
                {p.releasedAt ? ` · released ${formatDate(p.releasedAt.slice(0, 10))}` : ""}
              </span>
              {p.nextReleaseAt ? <span className={styles.muted}> · next {p.nextReleaseLabel ?? formatDate(p.nextReleaseAt.slice(0, 10))}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {!seriesFigure.ok ? (
        <RetryNote what="The series figure" />
      ) : seriesFigure.data ? (
        <div data-audit="series-figure-block">
          <p data-audit="series-figure">
            <b>
              {seriesFigure.data.row.label}: {seriesFigure.data.row.displayValue}
            </b>{" "}
            <span className={styles.muted}>
              {seriesFigure.data.row.unit ?? ""} · {ratingText(seriesFigure.data.rating?.tier)}
            </span>
          </p>
          <FreshnessBadge freshness={deriveSeriesFreshness({ as_at_date: seriesFigure.data.row.asAtDate, reference_period: seriesFigure.data.row.referencePeriod }, { cadenceDays: seriesFigure.data.cadenceDays }, nowIso)} />
          <ProvenanceDrawer envelope={envelopeFromSeriesRow(seriesFigure.data.row, producerFor(prefixOf(seriesFigure.data.row.seriesKey)) ?? null, seriesFigure.data.rating)} />
        </div>
      ) : null}
    </>
  );
}

export interface CarbonItem {
  jurisdictionIso: readonly string[];
  modes: readonly string[];
}

/** The carbon blocks of a corridor signal: the national modal default with its rating, and the per-FEU figure or its named gaps. */
export function CarbonFindings({ bundle, item, nowIso }: MarketBlockProps & { item: CarbonItem }) {
  const { carbon } = bundle;
  if (!carbon.ok) return <RetryNote what="Carbon intensity" />;
  const mode = item.modes.length === 1 ? (item.modes[0] ?? null) : null;
  const overlay = buildCarbonOverlayView({ jurisdictionIso: item.jurisdictionIso, factors: carbon.data.factors, mode });
  const sel = selectFactor(carbon.data.factors, { mode, jurisdictionIso: item.jurisdictionIso });
  const figure = sel.state === "resolved" ? intensityFigure(sel.factor, nowIso) : null;
  const rating = sel.state === "resolved" && sel.factor.source_key ? (carbon.data.ratings[sel.factor.source_key] ?? null) : null;
  const perFeu = buildCarbonCostPerFeuView({ jurisdictionIso: item.jurisdictionIso, modes: item.modes, factors: carbon.data.factors, corridorCandidates: carbon.data.corridorCandidates });
  return (
    <>
      <DetailSubSection title={overlay.header} subtitle="National modal default">
        <p className={styles.muted}>{overlay.body}</p>
        {figure ? <DerivedFigure figure={figure} label="Emission intensity" now={new Date(nowIso)} rating={ratingText(rating?.tier)} /> : null}
      </DetailSubSection>
      {perFeu?.result ? (
        <CarbonCostOverlay overlays={[{ label: perFeu.label ?? "", corridor: perFeu.result.corridor, entityId: "detail", jurisdictions: [], result: perFeu.result }]} />
      ) : perFeu?.body ? (
        <p className={styles.muted}>{perFeu.body}</p>
      ) : null}
    </>
  );
}
