// Ported from old_repo/src/components/operations/AuxiliaryEnergyPanelView.tsx (lines 1-60)
// Ported from old_repo/src/components/operations/GridQueuePanelView.tsx (lines 1-87)
// Ported from old_repo/src/components/operations/AuxiliaryEnergyPanel.tsx (lines 1-32)
// Ported from old_repo/src/components/operations/GridQueuePanel.tsx (lines 1-32)
// The Operations profile's panels, presentational (the page reads, these draw; the old loader/view split existed only so a node test could import the view): the workspace's auxiliary energy loads (kWh, and gCO2e
// when a SOURCED grid intensity for the region exists: the conversion the old card only named), the grid connection queue as a gate (blocked, clear or unknown, never a cost line) and the figures the flywheel
// recomputed from Operations inputs, each with its inputs and the weakest source rating. A figure that cannot be drawn names the data it needs; a failed read says so with Retry.
import { formatDate, formatFigure } from "@/core/shared";
import { RequestableCoverageState } from "@/features/coverage";
import { ABSENCE_DASH, CoverageState, MoreBelowDisclosure, RailCard, TierChip } from "@/ui";

import { auxiliaryEnergy } from "../calc/auxiliary-energy";
import { gridQueueGate } from "../calc/grid-queue";
import type { DerivedFigure } from "../model/derived-view";
import { DECISION_HORIZON_MONTHS, substationEvidence, type AuxiliaryEnergyRow, type GridIntensity, type GridQueueRow } from "../model/spec09";

import styles from "./operations.module.css";

/** Shown when a load's draw, duty cycle or hours cannot be used for an energy figure (the calculation's own reason is a developer's message and is not shown). */
const AUX_NO_ENERGY = "No energy figure: this load's draw, duty cycle or hours are not usable.";
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function AuxiliaryEnergyPanel({ rows, intensity, retryHref }: { rows: AuxiliaryEnergyRow[] | null; intensity: GridIntensity | null; retryHref: string }) {
  if (rows === null) return <CoverageState state="error" variant="inline" subject="Auxiliary energy loads" retryHref={retryHref} />;
  if (rows.length === 0) return <RequestableCoverageState state="not_covered" variant="inline" subject="Auxiliary energy loads" reason="No rows yet: auxiliary-load facts are specific to each asset and no public source publishes them." requestRef={`${retryHref}#auxiliary-energy`} />;
  const drawRow = (row: AuxiliaryEnergyRow) => {
    const { kwh, gco2e } = auxiliaryEnergy({ kwDraw: row.kw_draw, dutyCycle: row.duty_cycle, hoursTypical: row.hours_typical, gridIntensityGco2ePerKwh: intensity?.gco2ePerKwh ?? null });
    return (
      <div key={row.profile_id} className={styles.specCard}>
        <div className={styles.specCardHead}>
          <span className={styles.specCardTitle}>{row.load_type.replace(/_/g, " ")}</span>
          <span className={styles.derivedMeta}>{row.setpoint_c != null ? `${row.setpoint_c}°C` : "no setpoint"}{row.setpoint_rh_pct != null ? ` / ${row.setpoint_rh_pct}% RH` : ""}</span>
        </div>
        <div>{kwh.label === "M" ? AUX_NO_ENERGY : `${(kwh.value as number).toFixed(1)} kWh over ${row.hours_typical}h`}</div>
        <div className={styles.derivedMeta}>{gco2e.label === "M" ? "gCO2e: no sourced grid intensity is held for this region" : `${Math.round(gco2e.value as number)} gCO2e at ${intensity?.gco2ePerKwh} gCO2/kWh (${[intensity?.sourceName, intensity?.period].filter(Boolean).join(", ")})`}</div>
      </div>
    );
  };
  return (
    <div data-guard-container="auxiliary-energy" className={styles.spec}>
      <div className={styles.specGrid}>{rows.slice(0, 4).map(drawRow)}</div>
      {rows.length > 4 && <MoreBelowDisclosure count={rows.length - 4} itemNoun="more auxiliary loads"><div className={styles.specGrid}>{rows.slice(4).map(drawRow)}</div></MoreBelowDisclosure>}
    </div>
  );
}

export function GridQueuePanel({ rows, retryHref }: { rows: GridQueueRow[] | null; retryHref: string }) {
  if (rows === null) return <CoverageState state="error" variant="inline" subject="Grid connection queue" retryHref={retryHref} />;
  if (rows.length === 0) return <RequestableCoverageState state="not_covered" variant="inline" subject="Grid connection queue" reason="No rows yet: no free public source confirms demand-side connection-queue months." requestRef={`${retryHref}#grid-queue`} />;
  const statuses = rows.map((r) => { const g = gridQueueGate({ queueMonthsP90: r.queue_months_p90, horizonMonths: DECISION_HORIZON_MONTHS }); return g.label === "M" ? "UNKNOWN" : (g.value as string); });
  const clearCount = statuses.filter((s) => s === "CLEAR").length;
  const blockedCount = statuses.filter((s) => s === "BLOCKED").length;
  const unknownCount = statuses.length - clearCount - blockedCount;
  const drawSubstation = (row: GridQueueRow, idx: number) => {
    const status = statuses[idx] ?? "UNKNOWN";
    const detail = status === "UNKNOWN" ? "No p90 queue time is recorded for this operator and capacity band, so no gate is stated." : null;
    return (
      <div key={row.queue_id} className={styles.specCard}>
        <div className={styles.specCardHead}>
          <span className={styles.specCardTitle}>{row.substation_name ?? row.dso_name}</span>
          <span className={`${styles.gate}${status === "BLOCKED" ? ` ${styles.gateBlocked}` : status === "CLEAR" ? ` ${styles.gateClear}` : ""}`} title={detail ?? undefined}>{status}</span>
        </div>
        <div className={styles.derivedMeta}>{row.capacity_band_mw ?? (row.substation_name ? `${row.dso_name}. ${substationEvidence(row) ?? ""}` : "")}</div>
        <div className={styles.derivedMeta}>p50 {num(row.queue_months_p50) ?? "not recorded"}{row.queue_months_p50 != null ? " mo" : ""} · p90 {num(row.queue_months_p90) ?? "not recorded"}{row.queue_months_p90 != null ? " mo" : ""} · as of {row.as_of}</div>
        {detail && <div className={styles.derivedMeta}>{detail}</div>}
      </div>
    );
  };
  return (
    <div data-guard-container="grid-queue" className={styles.spec}>
      <div className={styles.specSummary}>
        <span>{rows.length} {rows.length === 1 ? "substation" : "substations"} monitored against {DECISION_HORIZON_MONTHS}-month horizon{[...new Set(rows.map((r) => r.dso_name.split(",")[0]?.trim()).filter(Boolean))].length > 0 ? ` · ${[...new Set(rows.map((r) => r.dso_name.split(",")[0]?.trim()).filter(Boolean))].join(", ")}` : ""}</span>
        <span>{clearCount} Clear · {blockedCount} Blocked · {unknownCount} Unknown</span>
      </div>
      <div className={styles.specGrid}>{rows.slice(0, 4).map((r, i) => drawSubstation(r, i))}</div>
      {rows.length > 4 && (
        <details data-audit="disclosure-row" className="cl-register-master">
          <summary className="cl-register-master-summary">
            <div className="cl-register-master-left">
              <span className="cl-register-master-title">All Monitored Substations in Queue ({rows.length - 4} additional)</span>
              <span className="cl-register-master-sub">Showing 4 of {rows.length} substations above. Expand to inspect the remaining {rows.length - 4} substation connection queues.</span>
            </div>
            <span className="cl-register-master-pill">Expand {rows.length - 4} more substations ▾</span>
          </summary>
          <div className="cl-pad-16"><div className={styles.specGrid}>{rows.slice(4).map((r, i) => drawSubstation(r, i + 4))}</div></div>
        </details>
      )}
    </div>
  );
}

const money = (f: DerivedFigure): string => (f.value === null ? "no value" : `${formatFigure(f.value)}${f.unit ? ` ${f.unit}` : ""}${f.currency && !f.unit?.includes(f.currency) ? ` ${f.currency}` : ""}`);

const drawFigure = (f: DerivedFigure) => (
  <li key={f.valueId} data-audit="derived-figure" className={styles.derivedItem}>
    <p className={styles.derivedTitle}>{f.title}</p>
    <span className={styles.derivedValue}>{money(f)}</span>
    {f.previous !== null && <span className={styles.derivedMeta}> (was {formatFigure(f.previous)})</span>}
    <p className={styles.derivedMeta}>{f.tier !== null ? <TierChip tier={f.tier} size="square" /> : <span aria-label="Source not rated" title="Source not rated">{ABSENCE_DASH}</span>} {[f.originClass, `recomputed ${formatDate(f.computedAt.slice(0, 10))}`].filter(Boolean).join(" · ")}</p>
    <p className={styles.derivedMeta}>From {f.inputs.length} {f.inputs.length === 1 ? "input" : "inputs"}: {f.inputs.map((i) => [i.label, i.period, i.sourceName].filter(Boolean).join(", ")).join("; ")}</p>
  </li>
);

/** The figures recomputed from Operations inputs: value, what it replaced, the method's origin, when, the inputs with their period and the weakest rating among them (an unrated input is an absence, not a tier). */
export function DerivedFigures({ figures, retryHref = "/operations" }: { figures: DerivedFigure[] | null; retryHref?: string }) {
  return (
    <RailCard title="Recalculated figures" dataAudit="derived-figures-rail">
      {figures === null ? <CoverageState state="error" variant="inline" subject="The recalculated figures" retryHref={retryHref} />
        : figures.length === 0 ? <CoverageState state="no_data_yet" variant="inline" subject="Recalculated figures" reason="No figure has been recomputed from an Operations input yet." />
        : <><ul className={styles.derived}>{figures.slice(0, 3).map(drawFigure)}</ul>{figures.length > 3 && <MoreBelowDisclosure count={figures.length - 3} itemNoun="more recalculated figures"><ul className={styles.derived}>{figures.slice(3).map(drawFigure)}</ul></MoreBelowDisclosure>}</>}
    </RailCard>
  );
}
