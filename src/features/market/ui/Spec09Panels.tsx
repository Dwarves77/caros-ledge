// Ported from old_repo/src/components/market/OemRoadmapPanelView.tsx (lines 1-59)
// Ported from old_repo/src/components/market/ReroutingPanelView.tsx (lines 1-62)
// Ported from old_repo/src/components/market/IndexationPanelView.tsx (lines 1-66)
// The three spec 09 panels. An empty panel is the named "not covered" gap with its Request coverage action; a failed read is a note with Retry. Corridors are named, never printed as ids; the panels state mechanics and arithmetic only
// (the product supplies the computation, counsel supplies the contract).
import type { ReactNode } from "react";

import { applyFuelBurnMultiplier, compoundingChain } from "../calc/reroute";
import { tcoCrossoverBand } from "../calc/oem-payload";
import type { IndexationRow, MarketPanels, OemRow, RerouteRow, Section } from "../read";

import { CoverageGap } from "./CoverageGap";
import { RetryNote } from "./RetryNote";
import styles from "./market.module.css";

const NOMINAL_BASELINE = 100;
const words = (s: string): string => s.replace(/_/g, " ");

function Panel({ id, title, subtitle, children }: { id: string; title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className={styles.band} data-guard-container={id}>
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle} data-guard-title>
          {title}
        </h2>
        <span className={styles.muted}>{subtitle}</span>
      </div>
      {children}
    </div>
  );
}

/** One panel's body: the failure note, the named gap when there are no rows, else the rows. */
function Body<T>({ id, subject, section, gap, children }: { id: string; subject: string; section: Section<T[]>; gap: string; children: (rows: T[]) => ReactNode }) {
  if (!section.ok) return <RetryNote what={subject} />;
  if (section.data.length === 0)
    return (
      <div className={styles.band} data-guard-container={id}>
        <CoverageGap subject={subject} reason={gap} requestRef={`/market#${id}`} />
      </div>
    );
  return <>{children(section.data)}</>;
}

const formatBand = (floor: number | null, cap: number | null): string => (floor === null && cap === null ? "no floor or cap" : floor !== null && cap !== null ? `${floor}% to ${cap}%` : floor !== null ? `floor ${floor}%, no cap` : `cap ${cap}%, no floor`);

export function Spec09Panels({ panels, corridorLabels }: { panels: MarketPanels; corridorLabels: Record<string, string> }) {
  const chain = compoundingChain();
  const tco = tcoCrossoverBand();
  const name = (id: string): string => corridorLabels[id] ?? "A corridor";
  return (
    <>
      <Body<OemRow> id="oem-roadmap" subject="OEM equipment roadmap" section={panels.oem} gap="No OEM roadmap announcements are on record.">
        {(rows) => (
          <Panel id="oem-roadmap" title="OEM equipment roadmap" subtitle="TRL 7-9 · vendor claims, evidence of intent, never of capability">
            {tco.label === "M" && <p className={styles.muted}>Diesel-parity cost crossover: not forecastable. A crossover interval needs cost-structure inputs and a fitted model over fuel and electricity prices, and a fitted date is refused rather than guessed.</p>}
            <div className={styles.cardGrid}>
              {rows.map((r) => (
                <div key={r.roadmap_id} className={styles.panelCard}>
                  <p className={styles.panelCardTitle}>{words(r.tech_category)}</p>
                  <p className={styles.muted}>
                    {words(r.commercial_stage)}
                    {r.target_year ? ` · target ${r.target_year}` : ""}
                  </p>
                  <p className={styles.muted}>
                    Density basis: {r.density_basis ?? "not stated"} · Confidence: {r.confidence_admiralty ?? "not stated"}
                  </p>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </Body>
      <Body<RerouteRow> id="rerouting" subject="Rerouting multipliers" section={panels.reroute} gap="No reroute events are on record.">
        {(rows) => (
          <Panel id="rerouting" title="Rerouting multipliers" subtitle="five surfaces move from one event">
            <div className={styles.cardList}>
              {rows.map((r) => {
                const scaled = applyFuelBurnMultiplier({ baselineFuelBurn: NOMINAL_BASELINE, fuelBurnMultiplier: r.fuel_burn_multiplier });
                const pct = "deltaPct" in scaled ? Number(scaled.deltaPct) : null;
                return (
                  <div key={r.reroute_id} className={styles.panelCard}>
                    <p className={styles.panelCardTitle}>{r.cause}</p>
                    <p className={styles.muted}>
                      {name(r.baseline_corridor_id)} → {name(r.reroute_corridor_id)}
                    </p>
                    <p className={styles.muted}>
                      Fuel burn ×{r.fuel_burn_multiplier} ({pct === null ? "no figure" : `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`})
                    </p>
                  </div>
                );
              })}
            </div>
            <p className={styles.muted}>Compounding chain: {chain.map((s) => s.detail).join(" → ")}</p>
          </Panel>
        )}
      </Body>
      <Body<IndexationRow> id="indexation-clauses" subject="Contract indexation terms" section={panels.indexation} gap="No contract indexation terms are on record for your organisation.">
        {(rows) => (
          <Panel id="indexation-clauses" title="Contract indexation terms" subtitle="mechanics and arithmetic only: the product supplies the computation, your counsel supplies the contract">
            <div className={styles.cardList}>
              {rows.map((r) => (
                <div key={r.clause_id} className={styles.panelCard}>
                  <p className={styles.panelCardTitle}>
                    {r.contract_ref || "No contract reference given"} · indexed to {r.index_id}
                  </p>
                  <p className={styles.muted}>
                    Base {r.base_value} at {r.base_date} · {r.passthrough_pct}% passthrough · band {formatBand(r.floor_pct, r.cap_pct)} · reviewed {r.review_cadence} · rounding: {String(r.rounding_rule).replace(/_/g, " ")}
                  </p>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </Body>
    </>
  );
}
