// Ported from old_repo/src/components/market/CarbonCostOverlay.tsx (lines 1-265)
// Carbon cost per FEU (spec 02 row 3): one card per corridor with its figure and the grade the ceiling gives it, and the four inputs it is computed from, each with its value, its basis and the rating of its source. Every number on a card is a derived value the
// propagate stage wrote; an input or a cost that is not there draws the sentence saying why, in the slot where the figure goes, and the section stays on the page. The corridor id anchors the card so "corridors this applies on" links land on it.
import { formatNumber } from "@/core/shared";
import { SectionCard } from "@/ui/SectionCard";
import { SectionHead } from "@/ui/SectionHead";

import type { CarbonCard } from "../lib/carbon";
import { ratingText } from "../lib/provenance";

import styles from "./market.module.css";

const GRADE = { statutory: "Statutory grade", display: "Display grade" } as const;
const money = (value: number, currency: string | null): string => `${currency ?? ""} ${formatNumber(value, { maximumFractionDigits: 0 })}`.trim();

function Inputs({ card }: { card: CarbonCard }) {
  return (
    <ul className={styles.gapList}>
      {card.inputs.map(({ input, label, state }) => (
        <li key={input} data-input={input} data-state={state.value ? "value" : "absent"}>
          <b>{label}</b>: {state.value ? `${formatNumber(state.value.value, { maximumFractionDigits: 2 })} ${state.value.unit ?? ""}`.trim() : state.reason}
          {state.value ? <span className={styles.muted}> · {state.basis}{state.sourceTier !== null ? ` · ${ratingText(state.sourceTier)}` : ""}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function CorridorCard({ card }: { card: CarbonCard }) {
  const { cost } = card;
  return (
    <div id={`corridor-${card.entityId}`} data-figure-kind={card.grade ?? "gap"} className={styles.corridor}>
      <div className={styles.corridorHead}>
        {card.grade ? <span className={styles.badge}>{GRADE[card.grade]}</span> : null}
        <span className={styles.corridorName}>{card.label}</span>
      </div>
      <p className={cost.value ? styles.corridorFigure : styles.muted}>
        {cost.value ? money(cost.value.value, cost.value.currency) : cost.reason}
        {cost.value ? <span className={styles.unitSuffix}> / FEU</span> : null}
      </p>
      <Inputs card={card} />
    </div>
  );
}

export function CarbonCostSection({ cards }: { cards: readonly CarbonCard[] }) {
  return (
    <div className={styles.band}>
      <SectionCard as="section" dataAudit="carbon-cost-per-feu" dataAttributes={{ "data-sec-theme": "operations" }}>
        <SectionHead title="Carbon cost per FEU" aside="per corridor, from the allowance price" />
        <p className="cl-detail-section-explainer-bar">The carbon cost of a forty-foot container on each corridor: the emission intensity of the corridor&apos;s mode, through its great-circle distance and the container payload, at the EU allowance price. Corridors are UN/LOCODE port pairs and a mode.</p>
        <div className={styles.cardBody}>

          {cards.length === 0 ? (
            <p className="cl-absence">No corridors are tracked</p>
          ) : (
            <div className={styles.corridorGrid}>
              {cards.map((c) => (
                <CorridorCard key={c.entityId} card={c} />
              ))}
            </div>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
