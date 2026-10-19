// Ported from old_repo/src/components/operations/AuxiliaryEnergyPanelView.tsx (lines 1-60)
// Ported from old_repo/src/components/operations/GridQueuePanelView.tsx (lines 1-87)
// Ported from old_repo/src/components/operations/AuxiliaryEnergyPanel.tsx (lines 1-32)
// Ported from old_repo/src/components/operations/GridQueuePanel.tsx (lines 1-32)
// The Operations profile's panels, presentational (the page reads, these draw; the old loader/view split existed only so a node test could import the view): the workspace's auxiliary energy loads (kWh, and gCO2e
// when a SOURCED grid intensity for the region exists: the conversion the old card only named), the grid connection queue as a gate (blocked, clear or unknown, never a cost line) and the figures the flywheel
// recomputed from Operations inputs, each with its inputs and the weakest source rating. A figure that cannot be drawn names the data it needs; a failed read says so with Retry.
import { formatDate } from "@/core/shared";
import { RequestableCoverageState } from "@/features/coverage/client";
import { Absence, CoverageState, RailCard, TierChip } from "@/ui";

import { auxiliaryEnergy } from "../calc/auxiliary-energy";
import { gridQueueGate } from "../calc/grid-queue";
import type { DerivedFigure } from "../model/derived-view";
import { DECISION_HORIZON_MONTHS, substationEvidence, type AuxiliaryEnergyRow, type GridIntensity, type GridQueueRow } from "../model/spec09";

import styles from "./operations.module.css";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function AuxiliaryEnergyPanel({ rows, intensity, retryHref }: { rows: AuxiliaryEnergyRow[] | null; intensity: GridIntensity | null; retryHref: string }) {
  if (rows === null) return <CoverageState state="error" variant="inline" subject="Auxiliary energy loads" retryHref={retryHref} />;
  if (rows.length === 0) return <RequestableCoverageState state="not_covered" variant="inline" subject="Auxiliary energy loads" reason="No rows yet: auxiliary-load facts are specific to each asset and no public source publishes them." requestRef={`${retryHref}#auxiliary-energy`} />;
  return (
    <div data-guard-container="auxiliary-energy" className={styles.spec}>
      {rows.map((row) => {
        const { kwh, gco2e } = auxiliaryEnergy({ kwDraw: row.kw_draw, dutyCycle: row.duty_cycle, hoursTypical: row.hours_typical, gridIntensityGco2ePerKwh: intensity?.gco2ePerKwh ?? null });
        return (
          <div key={row.profile_id} className={styles.specRow}>
            <div>
              <b>{row.load_type.replace(/_/g, " ")}</b>
              <div className={styles.derivedMeta}>
                {row.setpoint_c != null ? `${row.setpoint_c}°C` : "no setpoint"}
                {row.setpoint_rh_pct != null ? ` / ${row.setpoint_rh_pct}% RH` : ""}
              </div>
            </div>
            <div className={styles.termValue}>
              <div>{kwh.label === "M" ? `needs ${kwh.reason}` : `${(kwh.value as number).toFixed(1)} kWh over ${row.hours_typical}h`}</div>
              <div className={styles.derivedMeta}>
                {gco2e.label === "M" ? "gCO2e: needs a sourced grid intensity for this region" : `${Math.round(gco2e.value as number)} gCO2e at ${intensity?.gco2ePerKwh} gCO2/kWh (${[intensity?.sourceName, intensity?.period].filter(Boolean).join(", ")})`}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function GridQueuePanel({ rows, retryHref }: { rows: GridQueueRow[] | null; retryHref: string }) {
  if (rows === null) return <CoverageState state="error" variant="inline" subject="Grid connection queue" retryHref={retryHref} />;
  if (rows.length === 0) return <RequestableCoverageState state="not_covered" variant="inline" subject="Grid connection queue" reason="No rows yet: no free public source confirms demand-side connection-queue months." requestRef={`${retryHref}#grid-queue`} />;
  return (
    <div data-guard-container="grid-queue" className={styles.spec}>
      {rows.map((row) => {
        const gate = gridQueueGate({ queueMonthsP90: row.queue_months_p90, horizonMonths: DECISION_HORIZON_MONTHS });
        const status = gate.label === "M" ? "UNKNOWN" : (gate.value as string);
        const detail = status === "UNKNOWN" ? "needs the p90 queue months for this operator and capacity band" : null;
        return (
          <div key={row.queue_id} className={styles.specRow}>
            <div>
              <b>{row.substation_name ?? row.dso_name}</b>
              <div className={styles.derivedMeta}>{row.capacity_band_mw ?? (row.substation_name ? `${row.dso_name}. ${substationEvidence(row) ?? ""}` : "")}</div>
            </div>
            <div className={styles.termValue}>
              <span className={`${styles.gate}${status === "BLOCKED" ? ` ${styles.gateBlocked}` : status === "CLEAR" ? ` ${styles.gateClear}` : ""}`} title={detail ?? undefined}>{status}</span>
              <div className={styles.derivedMeta}>
                p50 {num(row.queue_months_p50) ?? "needs p50 queue months"}
                {row.queue_months_p50 != null ? " mo" : ""} · p90 {num(row.queue_months_p90) ?? "needs p90 queue months"}
                {row.queue_months_p90 != null ? " mo" : ""} · as of {row.as_of}
              </div>
              {detail && <div className={styles.derivedMeta}>{detail}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const money = (f: DerivedFigure): string => (f.value === null ? "no value" : `${f.value}${f.unit ? ` ${f.unit}` : ""}${f.currency && !f.unit?.includes(f.currency) ? ` ${f.currency}` : ""}`);

/** The figures recomputed from Operations inputs: value, what it replaced, the method's origin, when, the inputs with their period and the weakest rating among them (an unrated input is an absence, not a tier). */
export function DerivedFigures({ figures, retryHref = "/operations" }: { figures: DerivedFigure[] | null; retryHref?: string }) {
  return (
    <RailCard title="Recalculated figures" dataAudit="derived-figures-rail">
      {figures === null ? (
        <CoverageState state="error" variant="inline" subject="The recalculated figures" retryHref={retryHref} />
      ) : figures.length === 0 ? (
        <CoverageState state="no_data_yet" variant="inline" subject="Recalculated figures" reason="No figure has been recomputed from an Operations input yet." />
      ) : (
        <ul className={styles.derived}>
          {figures.map((f) => (
            <li key={f.valueId} data-audit="derived-figure" className={styles.derivedItem}>
              <p className={styles.derivedTitle}>{f.title}</p>
              <span className={styles.derivedValue}>{money(f)}</span>
              {f.previous !== null && <span className={styles.derivedMeta}> (was {f.previous})</span>}
              <p className={styles.derivedMeta}>
                {f.tier !== null ? <TierChip tier={f.tier} size="square" /> : <Absence reason="not in primary source" variant="dash" />}{" "}
                {[f.originClass, `recomputed ${formatDate(f.computedAt.slice(0, 10))}`].filter(Boolean).join(" · ")}
              </p>
              <p className={styles.derivedMeta}>
                From {f.inputs.length} {f.inputs.length === 1 ? "input" : "inputs"}: {f.inputs.map((i) => [i.label, i.period, i.sourceName].filter(Boolean).join(", ")).join("; ")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </RailCard>
  );
}
