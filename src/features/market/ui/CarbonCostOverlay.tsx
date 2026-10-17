// Ported from old_repo/src/components/market/CarbonCostOverlay.tsx (lines 1-265)
// Carbon cost per FEU (spec 02 row 3): one card per corridor with its figure range, or the named gaps, and the inputs already resolved. The range is low, point and high together; a missing input is its own line and nothing is
// invented. The corridor id anchors the card so "corridors this applies on" links land on it.
import { formatRange } from "@/core/figures";
import { SectionCard } from "@/ui/SectionCard";
import { SectionHead } from "@/ui/SectionHead";

import type { CarbonCostResult, CarbonOverlayEntry } from "../lib/carbon";

import styles from "./market.module.css";

const BADGE = { statutory: "Statutory", derived: "Derived", estimate: "Estimate", gap: "Gap" } as const;

function Inputs({ result }: { result: CarbonCostResult }) {
  const p = result.ok ? { intensity: result.intensity, distance: result.distance, payload: result.payload, carbonPrice: result.carbonPrice } : result.partial;
  const chips: Array<[string, string]> = [];
  if (p.intensity) chips.push([`${p.intensity.headlineLabel} factor · ${p.intensity.sourceKey ?? "unknown source"}`, `Emission intensity: ${p.intensity.unit}`]);
  if (p.distance) chips.push(["Distance", p.distance.basis]);
  if (p.payload) chips.push(["Payload per FEU", p.payload.basis]);
  if (p.carbonPrice) chips.push([`Carbon price · ${p.carbonPrice.sourceKey}`, `${p.carbonPrice.basis}${p.carbonPrice.asOf ? ` (as of ${p.carbonPrice.asOf})` : ""}`]);
  return chips.length === 0 ? null : (
    <div className={styles.chips}>
      {chips.map(([label, title]) => (
        <span key={label} title={title} className={styles.chip}>
          {label}
        </span>
      ))}
    </div>
  );
}

function CorridorCard({ entry }: { entry: CarbonOverlayEntry }) {
  const { result } = entry;
  const kind = result.ok ? result.classification : "gap";
  return (
    <div id={`corridor-${entry.entityId}`} data-figure-kind={kind} className={styles.corridor}>
      <div className={styles.corridorHead}>
        <span className={styles.badge}>{BADGE[kind]}</span>
        <span className={styles.corridorName}>{entry.label}</span>
      </div>
      {entry.jurisdictions.length > 0 && (
        <div className={styles.chips}>
          {entry.jurisdictions.map((j) => (
            <span key={j.code} title="Jurisdiction this corridor touches" className={styles.chip}>
              {j.name ? `${j.name} (${j.code})` : j.code}
            </span>
          ))}
        </div>
      )}
      {result.ok ? (
        <p className={styles.corridorFigure}>
          {formatRange(result.low, result.point, result.high, null, result.currency)}
          <span className={styles.unitSuffix}> / FEU</span>
        </p>
      ) : (
        <ul className={styles.gapList}>
          {result.gaps.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      )}
      <Inputs result={result} />
    </div>
  );
}

export function CarbonCostOverlay({ overlays }: { overlays: readonly CarbonOverlayEntry[] }) {
  if (overlays.length === 0) return null;
  return (
    <div className={styles.band}>
      <SectionCard as="section" dataAudit="carbon-cost-per-feu">
        <SectionHead title="Carbon cost per FEU" aside="per corridor, from carrier-published surcharges" />
        <div className={styles.cardBody}>
          <p className={styles.muted}>The carbon cost of a forty-foot container on each corridor: the emission factor for the corridor&apos;s mode, through its routing distance and container payload, at a carrier-published carbon price. Corridors are UN/LOCODE port pairs and a mode.</p>
          <div className={styles.corridorGrid}>
            {overlays.map((e) => (
              <CorridorCard key={e.entityId} entry={e} />
            ))}
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
