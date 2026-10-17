// Ported from old_repo/src/app/admin/factors/page.tsx (lines 61-239)
import { formatDate, formatLocaleDate } from "@/core/shared";
import { Masthead, RowTable, StateNote } from "@/ui";

import { kindLabel, valueCell } from "./console-math";
import styles from "./admin.module.css";

export interface FactorRow {
  factor_id: string;
  tier: string;
  mode: string;
  vehicle_class: string | null;
  energy_carrier: string | null;
  jurisdiction: string | null;
  operator_key: string | null;
  corridor_id: string | null;
  quantity_basis: string;
  wtt_co2e: number | null;
  ttw_co2e: number | null;
  wtw_co2e: number | null;
  gwp_basis: string;
  derivation: string;
  origin_class: string;
  pedigree: number;
  as_at_date: string;
  superseded_by: string | null;
  source_key: string;
  data_sources: { name: string; licence: string | null; embeddable: boolean } | null;
}
const TIER_LABEL: Record<string, string> = { carrier_primary: "Carrier primary", verified_operator_avg: "Verified operator avg", programme_lane_avg: "Programme lane avg", modal_default: "Modal default", proxy_estimate: "Proxy estimate" };

/** The emission factors table, read-only: tier, kind, value, unit, envelope, as-at date and licence; superseded rows are marked, not hidden. */
export function FactorsPage({ rows, error, nowIso }: { rows: FactorRow[] | null; error: string | null; nowIso: string }) {
  const live = (rows ?? []).filter((r) => !r.superseded_by).length;
  return (
    <>
      <div className={styles.head}>
        <Masthead title="Emission factors" size="list" dateLabel={formatLocaleDate(new Date(nowIso), { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })} nowIso={nowIso} eyebrowSuffix="Platform admin · emission factors" dek={error || !rows ? "The factors could not be read." : `${rows.length} row${rows.length === 1 ? "" : "s"} · ${live} live${rows.length > live ? ` · ${rows.length - live} superseded` : ""} · read-only`} />
      </div>
      <div className={styles.single}>
        {error || !rows ? (
          <StateNote tone="error">The emission factors did not load: {error ?? "no answer"}.</StateNote>
        ) : rows.length === 0 ? (
          <StateNote>No emission factors have been written yet.</StateNote>
        ) : (
          <div className={styles.scroll}>
          <RowTable
            columns={[{ label: "Tier", width: "170px" }, { label: "Kind", width: "minmax(220px, 2fr)" }, { label: "Value (kg CO2e)", width: "minmax(160px, 1fr)" }, { label: "Unit", width: "110px" }, { label: "Envelope", width: "minmax(220px, 2fr)" }, { label: "As at", width: "110px" }, { label: "Licence", width: "160px" }]}
            rows={rows.map((f) => ({
              key: f.factor_id,
              cells: [
                <span key="t" className={styles.cell}>{TIER_LABEL[f.tier] ?? f.tier}{f.superseded_by ? <><br /><span className={styles.muted}>superseded</span></> : null}</span>,
                <span key="k" className={styles.cell}>{kindLabel(f)}</span>,
                <b key="v" className={styles.cell}>{valueCell(f)}</b>,
                <span key="u">{f.quantity_basis}</span>,
                <span key="e" className={styles.cell}>{f.origin_class} · {f.derivation} · pedigree {f.pedigree} · {f.gwp_basis}</span>,
                <span key="a">{formatDate(f.as_at_date)}</span>,
                <span key="l" className={f.data_sources?.embeddable ? styles.pill : styles.pillBad} title={f.data_sources?.licence ?? undefined}>{f.data_sources?.name ?? f.source_key}</span>,
              ],
            }))}
          />
          </div>
        )}
      </div>
    </>
  );
}
