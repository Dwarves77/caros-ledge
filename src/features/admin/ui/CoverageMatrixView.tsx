"use client";

// Ported from old_repo/src/components/admin/CoverageMatrixView.tsx (lines 170-615)
// Ported from old_repo/src/components/admin/CoverageMatrixView.tsx (lines 719-762)
import { useState } from "react";

import { formatNumber } from "@/core/shared";
import { Button, EmptyState, FilterChip, FilterChipGroup, StatBlock, Switch } from "@/ui";

import type { CellState, OverallState } from "../api/coverage";

import { Load, Panel, useAdminFetch } from "./panel-kit";
import styles from "./admin.module.css";

interface Cell {
  jurisdiction_iso: string;
  item_type: string;
  item_count: number;
  source_count: number;
  most_recent_item_at: string | null;
  has_critical: boolean;
  cell_state: CellState;
}
interface Jurisdiction {
  jurisdiction_iso: string;
  label: string;
  country: string;
  tier: 1 | 2 | 3 | null;
  total_items: number;
  total_sources: number;
  overall_state: OverallState;
}
interface Payload {
  generated_at: string;
  matrix: Cell[];
  jurisdictions: Jurisdiction[];
  item_types: string[];
}

const CELL_WORDS: Record<CellState, { label: string; description: string; tone: string }> = {
  "gap-no-source": { label: "Gap, no source", description: "No items and no active source. Discovery has not run, or sources are paused.", tone: styles.cellGap ?? "" },
  "gap-with-source": { label: "Gap, sources tracked", description: "An active source but no items yet.", tone: styles.cellStale ?? "" },
  sparse: { label: "Sparse", description: "One or two items. Coverage exists but is thin.", tone: styles.cellSparse ?? "" },
  "covered-stale": { label: "Covered, stale", description: "Three or more items, the newest older than 180 days.", tone: styles.cellStale ?? "" },
  "covered-fresh": { label: "Covered, fresh", description: "Three or more items, the newest within 180 days.", tone: styles.cellFresh ?? "" },
};

/** Roll the visible jurisdictions up to one row per country, the worst overall state winning. Pure. */
function groupByCountry(js: readonly Jurisdiction[]): Jurisdiction[] {
  const order: OverallState[] = ["gap", "partial", "covered"];
  const out = new Map<string, Jurisdiction>();
  for (const j of js) {
    const have = out.get(j.country);
    if (!have) out.set(j.country, { ...j, jurisdiction_iso: j.country, label: j.country === j.jurisdiction_iso ? j.label : j.country });
    else {
      have.total_items += j.total_items;
      have.total_sources = Math.max(have.total_sources, j.total_sources);
      if (order.indexOf(j.overall_state) < order.indexOf(have.overall_state)) have.overall_state = j.overall_state;
    }
  }
  return [...out.values()];
}

/** Coverage by jurisdiction and item type. Every cell is a 44 px button with its state in words (never colour alone); selecting a jurisdiction offers to add sources for it. Gaps are said as gaps, never zeros. */
export function CoverageMatrixView({ onBulkAdd }: { onBulkAdd: (iso: string) => void }) {
  const [tier, setTier] = useState<1 | 2 | 3 | null>(null);
  const [byCountry, setByCountry] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const q = useAdminFetch<Payload>(`/api/admin/coverage${tier ? `?tier=${tier}` : ""}`);
  return (
    <Panel title="Coverage matrix" aside={q.data ? `Read ${q.data.generated_at.slice(0, 10)}` : undefined} onRefresh={q.reload}>
      <FilterChipGroup label="Tier">
        <FilterChip active={tier === null} onClick={() => setTier(null)}>All</FilterChip>
        {([1, 2, 3] as const).map((t) => <FilterChip key={t} active={tier === t} onClick={() => setTier(tier === t ? null : t)}>Tier {t}</FilterChip>)}
      </FilterChipGroup>
      <div className={styles.actions}><Switch on={byCountry} onChange={setByCountry} label="Group by country" /><span className={styles.note}>Group by country</span></div>
      <Load q={q} what="The coverage matrix">
        {(d) => {
          const shown = byCountry ? groupByCountry(d.jurisdictions) : d.jurisdictions;
          const types = byCountry ? [] : d.item_types;
          const count = (s: OverallState) => shown.filter((j) => j.overall_state === s).length;
          const cells = new Map<string, Map<string, Cell>>();
          for (const c of d.matrix) cells.set(c.jurisdiction_iso, (cells.get(c.jurisdiction_iso) ?? new Map()).set(c.item_type, c));
          const pick = d.jurisdictions.find((j) => j.jurisdiction_iso === selected) ?? shown.find((j) => j.jurisdiction_iso === selected);
          return shown.length === 0 ? (
            <EmptyState>No jurisdictions are in scope for this filter.</EmptyState>
          ) : (
            <>
              <div className={styles.grid3}>
                <StatBlock label="Covered" value={formatNumber(count("covered"))} />
                <StatBlock label="Partial" value={formatNumber(count("partial"))} />
                <StatBlock label="Total gaps" value={formatNumber(count("gap"))} tone={count("gap") > 0 ? "critical" : "default"} />
              </div>
              <div className={styles.scroll} data-guard-strip="true">
                <div className={styles.matrix} style={{ gridTemplateColumns: `minmax(160px, 1.4fr) repeat(${types.length}, 56px)` }} role="table" aria-label="Coverage by jurisdiction and item type">
                  <span role="columnheader" className={styles.muted}>Jurisdiction</span>
                  {types.map((t) => <span key={t} role="columnheader" className={styles.muted} title={t}>{t.replace(/_/g, " ").slice(0, 8)}</span>)}
                  {shown.map((j) => (
                    <div key={j.jurisdiction_iso} role="row" style={{ display: "contents" }}>
                      <button type="button" role="rowheader" className={`${styles.rowBtn} ${j.jurisdiction_iso === selected ? styles.strong : ""}`} aria-current={j.jurisdiction_iso === selected ? "true" : undefined} onClick={() => setSelected(j.jurisdiction_iso === selected ? null : j.jurisdiction_iso)}>
                        <span className={styles.truncate}>{j.label}{j.tier ? ` · T${j.tier}` : ""}</span>
                        <span className={styles.muted}>{formatNumber(j.total_items)} items</span>
                      </button>
                      {types.map((t) => {
                        const c = cells.get(j.jurisdiction_iso)?.get(t);
                        return (
                          <span key={t} role="cell" className={`${styles.matrixCell} ${c ? CELL_WORDS[c.cell_state].tone : styles.cellNone}`} title={c ? `${CELL_WORDS[c.cell_state].label}: ${c.item_count} items, ${c.source_count} sources` : "No item of this type"}>
                            {c ? (c.item_count > 0 ? c.item_count : "gap") : "—"}
                          </span>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
              <div className={styles.chips} aria-label="Legend">
                {Object.values(CELL_WORDS).map((w) => <span key={w.label} className={styles.pill} title={w.description}>{w.label}</span>)}
              </div>
              {pick ? (
                <div className={styles.detail}>
                  <b className={styles.strong}>{pick.label}</b>
                  <p className={styles.note}>{formatNumber(pick.total_items)} items, {formatNumber(pick.total_sources)} active sources. {pick.overall_state === "gap" ? "Nothing is tracked here." : pick.overall_state === "partial" ? "Coverage is thin." : "Covered."}</p>
                  <div className={styles.actions}><Button variant="primary" size="sm" onClick={() => onBulkAdd(pick.jurisdiction_iso)}>Add sources for {pick.label}</Button></div>
                </div>
              ) : null}
            </>
          );
        }}
      </Load>
    </Panel>
  );
}
