"use client";

// Ported from old_repo/src/components/operations/RegionDimensionMatrix.tsx (lines 122-1075)
// The region by dimension scoreboard and its ONE panel. Arrival state (operator 2026-09-09, item 5, coordinator note C1): the first sourced cell of the first sourced row is SELECTED and its panel is showing; this is the
// one element on the site that opens itself, and it declares itself (`data-open-on-mount`) until the reader acts. Arrows move the selection and the panel follows, Home and End move only, Esc closes from anywhere in
// the card, a row header opens compare mode. The card height is constant across untouched, selected, compare and closed (the panel slot has a fixed height and scrolls inside). The dimension column stays pinned while the
// regions scroll; every cell is 44 px tall (law 2; artboard 08 draws 40: DESIGN CHANGES OWED).
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { Absence, CoverageState, FactCard, SectionCard } from "@/ui";

import { dimensionLabel, LABOUR_DIMENSION, type Dimension } from "../model/dimensions";
import { buildRegionGrid, cellKey, impliedBaseFact, toMatrixFact, type CoverageRow, type OperationsFact } from "../model/region-grid";

import { LabourChain } from "./LabourChain";
import styles from "./operations.module.css";

const COLUMNS_BEFORE_SCROLL = 5;
const PANEL_FACT_CAP = 3;
const ARRIVAL = "operator 2026-09-09 item 5: the first sourced cell of the first sourced row is open on arrival; the one allowed exception to the rule that nothing opens itself (coordinator note C1)";

export interface MatrixRegion {
  key: string;
  label: string;
}
interface Selection {
  /** Null is the row header: compare mode across every column. */
  regionKey: string | null;
  dimDb: string;
}
export interface RegionMatrixProps {
  /** The columns, already scoped by the rail's Region facet. */
  regions: MatrixRegion[];
  /** The rows, already scoped by the rail's Dimension facet. */
  dimensions: readonly Dimension[];
  facts: readonly OperationsFact[];
  coverageRows?: readonly CoverageRow[];
  /** Regulations per region; null when that read failed (the column says the count is unavailable, never zero). */
  crossRefCounts: Record<string, number> | null;
  /** The size of the unscoped roster, for "5 of 18 regions". */
  totalRegionCount?: number;
  profileHrefByRegion?: Record<string, string>;
}

export function RegionMatrix({ regions, dimensions, facts, coverageRows = [], crossRefCounts, totalRegionCount, profileHrefByRegion = {} }: RegionMatrixProps) {
  const panelId = useId();
  /** Undefined: the reader has not acted and the default is in force. Null: the reader pressed Esc. */
  const [selection, setSelection] = useState<Selection | null | undefined>(undefined);
  const [focusPos, setFocusPos] = useState<{ r: number; c: number } | null>(null);
  const moveRef = useRef(false);
  const cellRefs = useRef(new Map<string, HTMLElement | null>());
  const grid = useMemo(() => buildRegionGrid({ regionKeys: regions.map((r) => r.key), sourcedDimensions: dimensions.map((d) => d.db), facts, coverageRows, crossRefCountsByRegion: crossRefCounts }), [regions, dimensions, facts, coverageRows, crossRefCounts]);
  const cellAt = useCallback((region: string, dim: string) => grid.byCell[cellKey(region, dim)] ?? null, [grid]);

  const defaultSelection = useMemo<Selection | null>(() => dimensions.flatMap((d) => regions.map((r) => ({ regionKey: r.key, dimDb: d.db }))).find((s) => (cellAt(s.regionKey, s.dimDb)?.factCount ?? 0) > 0) ?? null, [dimensions, regions, cellAt]);
  const untouched = selection === undefined;
  // A selection the rail has scoped away re-points at the default; an Esc stays closed.
  const resolved: Selection | null = selection === undefined ? defaultSelection : selection === null ? null : dimensions.some((d) => d.db === selection.dimDb) && (selection.regionKey === null || regions.some((r) => r.key === selection.regionKey)) ? selection : defaultSelection;
  const rowIndex = resolved ? dimensions.findIndex((d) => d.db === resolved.dimDb) : -1;
  const colIndex = resolved ? (resolved.regionKey === null ? 0 : regions.findIndex((r) => r.key === resolved.regionKey) + 1) : -1;
  const clampR = useCallback((r: number) => Math.max(0, Math.min(dimensions.length - 1, r)), [dimensions.length]);
  const clampC = useCallback((c: number) => Math.max(0, Math.min(regions.length, c)), [regions.length]);
  const focusR = clampR(focusPos ? focusPos.r : Math.max(0, rowIndex));
  const focusC = clampC(focusPos ? focusPos.c : Math.max(0, colIndex));

  const moveFocus = useCallback((r: number, c: number) => {
    moveRef.current = true;
    setFocusPos({ r: clampR(r), c: clampC(c) });
  }, [clampR, clampC]);
  const selectAt = useCallback((r: number, c: number) => {
    const row = dimensions[clampR(r)];
    if (!row) return;
    const cc = clampC(c);
    moveFocus(r, c);
    setSelection({ regionKey: cc === 0 ? null : (regions[cc - 1]?.key ?? null), dimDb: row.db });
  }, [dimensions, regions, clampR, clampC, moveFocus]);

  const onCellKeyDown = useCallback((e: React.KeyboardEvent, r: number, c: number) => {
    const moves: Record<string, [number, number]> = { ArrowRight: [r, c + 1], ArrowLeft: [r, c - 1], ArrowDown: [r + 1, c], ArrowUp: [r - 1, c] };
    const to = moves[e.key];
    if (to) {
      e.preventDefault();
      selectAt(to[0], to[1]);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      moveFocus(r, e.key === "Home" ? 0 : regions.length);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setSelection(null);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectAt(r, c);
    }
  }, [moveFocus, selectAt, regions.length]);
  useEffect(() => {
    if (!moveRef.current) return;
    moveRef.current = false;
    cellRefs.current.get(`${focusR}:${focusC}`)?.focus();
  }, [focusR, focusC]);

  if (regions.length === 0 || dimensions.length === 0) return null;
  const arrival = untouched ? { "data-open-on-mount": ARRIVAL } : null;
  const dim = rowIndex >= 0 ? (dimensions[rowIndex] as Dimension) : null;
  const region = resolved?.regionKey ? (regions.find((r) => r.key === resolved.regionKey) ?? null) : null;
  const totalRegions = totalRegionCount ?? regions.length;
  const note = (r: string, d: string) => coverageRows.find((c) => c.regionCode === r && c.dimension === d)?.notes ?? null;
  const countOf = (r: MatrixRegion | null, d: Dimension) => (r ? (cellAt(r.key, d.db)?.factCount ?? 0) : regions.reduce((n, x) => n + (cellAt(x.key, d.db)?.factCount ?? 0), 0));
  const countWords = (n: number) => (n === 0 ? "no sourced fact" : `${n} sourced ${n === 1 ? "fact" : "facts"}`);

  return (
    <SectionCard as="section" dataAudit="ops-matrix-card" dataAttributes={{ "data-sec-theme": "operations" }} className={styles.card ?? ""} onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), setSelection(null))}>
      <header className={styles.head}>
        <h2 className={styles.title}>Regions side by side</h2>
        <span data-audit="ops-matrix-hint" className={styles.hint}>
          {grid.fillRate.filled} of {grid.fillRate.total} cells sourced · {grid.fillRate.pct}% · {totalRegions} regions{regions.length > COLUMNS_BEFORE_SCROLL ? " · scroll →" : ""}
        </span>
      </header>
      <p className="cl-detail-section-explainer-bar">Cross-regional operational readiness matrix comparing sourced fact counts across 12 infrastructure, labour, grid, and customs dimensions. Select any cell to inspect its held figures below.</p>
      <div className={`${styles.scroller} cl-scroll-shadow`} data-guard-strip="true">
        <table role="grid" aria-label="Regions by dimension, sourced fact counts" className={styles.table}>
          <thead className={styles.thead}>
            <tr role="row">
              <th role="columnheader" scope="col" data-guard-sticky-col="true" className={`${styles.th} ${styles.sticky} ${styles.thSticky}`}>Dimension</th>
              {regions.map((r) => {
                const cov = grid.regionCoverage.find((c) => c.regionKey === r.key);
                return (
                  <th role="columnheader" scope="col" key={r.key} className={styles.th}>
                    <div>{r.label}</div>
                    <div className={`${styles.thSub}${cov?.filled ? "" : ` ${styles.thSubGap}`}`}>
                      {cov?.filled ?? 0}/{cov?.total ?? 0} sourced{cov?.crossReferenceCount === null ? " · regs unavailable" : (cov?.crossReferenceCount ?? 0) > 0 ? ` · ${cov?.crossReferenceCount} regs` : ""}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {dimensions.map((d, ri) => {
              const headSelected = ri === rowIndex && colIndex === 0;
              return (
                <tr role="row" key={d.db}>
                  <th role="rowheader" scope="row" ref={(el) => void cellRefs.current.set(`${ri}:0`, el)} tabIndex={ri === focusR && focusC === 0 ? 0 : -1} aria-selected={headSelected} {...(headSelected ? arrival : null)} aria-controls={panelId} aria-label={`${dimensionLabel(d)}, compare across every region`} onClick={() => selectAt(ri, 0)} onKeyDown={(e) => onCellKeyDown(e, ri, 0)} data-guard-sticky-col="true" className={`${styles.cell} ${styles.sticky} ${styles.rowHead}${headSelected ? ` ${styles.selected}` : ""}`}>
                    <span className={styles.rowLabel}>
                      <span aria-hidden="true" className={styles.dnum}>D{d.num}</span>
                      <span data-guard-title className={styles.dname}>{d.name}</span>
                    </span>
                  </th>
                  {regions.map((r, i) => {
                    const n = cellAt(r.key, d.db)?.factCount ?? 0;
                    const sel = ri === rowIndex && i + 1 === colIndex;
                    return (
                      <td role="gridcell" key={r.key} ref={(el) => void cellRefs.current.set(`${ri}:${i + 1}`, el)} tabIndex={ri === focusR && i + 1 === focusC ? 0 : -1} aria-selected={sel} {...(sel ? arrival : null)} aria-controls={panelId} aria-label={`${r.label}, ${dimensionLabel(d)}, ${countWords(n)}`} onClick={() => selectAt(ri, i + 1)} onKeyDown={(e) => onCellKeyDown(e, ri, i + 1)} className={`${styles.cell}${sel ? ` ${styles.selected}` : ""}`}>
                        {n === 0 ? <CoverageState state="not_covered" variant="cell" subject={`${dimensionLabel(d)} for ${r.label}`} reason="Nothing is held for this region and dimension yet." /> : <span data-audit="ops-cell-score" data-guard-display="matrix-cell-score" className={styles.score}>{n}</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div id={panelId} data-audit="ops-matrix-panel" role="region" aria-live="polite" aria-label={dim ? `${region ? region.label : "Every region"} · ${dimensionLabel(dim)} · ${countWords(countOf(region, dim))}` : "No cell selected"} {...(dim ? arrival : null)} className={styles.panel}>
        {dim ? (
          <Panel dimension={dim} region={region} regions={regions} cellAt={cellAt} profileHref={region ? (profileHrefByRegion[region.key] ?? null) : null} note={region ? note(region.key, dim.db) : null} onCompare={() => selectAt(rowIndex, 0)} count={countWords(countOf(region, dim))} />
        ) : (
          <p data-audit="ops-panel-empty" className={styles.muted}>Panel closed. Click a cell, or arrow to one, to read its facts.</p>
        )}
      </div>
      <div data-audit="ops-matrix-foot" className={styles.foot}>
        <span>
          <Absence reason="not in primary source" variant="dash" /> <Absence reason="not in primary source" /> · click a cell to open its facts · arrow keys move the selection
        </span>
        <span>{totalRegions > regions.length ? `${regions.length} of ${totalRegions} regions` : `${regions.length} regions`} · filters scope columns</span>
      </div>
      {(grid.emptyRegions.length > 0 || grid.reconciliation.disagreed.length > 0) && (
        <div className={styles.notes}>
          {grid.emptyRegions.length > 0 && (
            <p className={styles.noteText}>
              <strong>{grid.emptyRegions.join(" and ")} hold no sourced facts on any dimension.</strong> Regulation counts for those regions sit in the column header and are not part of the coverage figure.
            </p>
          )}
          {grid.reconciliation.disagreed.length > 0 && <p className={styles.noteWarn}>The coverage summary and the facts held disagree on {grid.reconciliation.disagreed.length} of {grid.reconciliation.checked} cells. The counts above are computed from the facts.</p>}
        </div>
      )}
    </SectionCard>
  );
}

type CellAt = (region: string, dim: string) => { factCount: number; facts: OperationsFact[] } | null;

/** The panel body: one cell's facts as cards (three, then "N more on the profile"), the labour chain for the labour dimension, or compare mode: one headline card per region with the implied-base index. */
function Panel({ dimension, region, regions, cellAt, profileHref, note, onCompare, count }: { dimension: Dimension; region: MatrixRegion | null; regions: MatrixRegion[]; cellAt: CellAt; profileHref: string | null; note: string | null; onCompare: () => void; count: string }) {
  const cell = region ? cellAt(region.key, dimension.db) : null;
  const shown = region ? (cell?.facts ?? []).slice(0, PANEL_FACT_CAP) : [];
  const more = region ? Math.max(0, (cell?.factCount ?? 0) - shown.length) : 0;
  const compare = region ? [] : regions.map((r) => ({ region: r, fact: cellAt(r.key, dimension.db)?.facts[0] ?? null }));
  const base = impliedBaseFact(compare.map((x) => x.fact));
  return (
    <>
      <div className={styles.panelHead}>
        <span data-audit="ops-panel-heading" className={styles.panelTitle}>
          {region ? region.label : "Every region"} · <strong>{dimensionLabel(dimension)}</strong> · {count}
        </span>
        <span className={styles.panelLinks}>
          {region && <button type="button" onClick={onCompare} className={styles.link}>Compare across regions</button>}
          {region && profileHref && <a href={profileHref} className={styles.link}>Open profile &rarr;</a>}
        </span>
      </div>
      {note && region && <p className={styles.plain}>{note}</p>}
      {!region ? (
        compare.map(({ region: r, fact }) => (
          <div key={r.key}>
            <p data-audit="ops-compare-label" className={styles.compareLabel}>{r.label}</p>
            {fact ? <FactCard density="matrix" fact={toMatrixFact(fact, fact === base ? null : base)} /> : <p className={styles.plain}><Absence reason="not in primary source" /></p>}
          </div>
        ))
      ) : shown.length === 0 ? (
        <p data-audit="ops-panel-absent" className={styles.plain}>
          <Absence reason="not in primary source" />: nothing is held for {dimensionLabel(dimension)} in {region.label}. Nothing is estimated in its place.
        </p>
      ) : dimension.db === LABOUR_DIMENSION ? (
        <LabourChain facts={cell?.facts ?? []} regionLabel={region.label} />
      ) : (
        <>
          {shown.map((f, i) => (
            <FactCard key={i} density="matrix" fact={toMatrixFact(f, null)} />
          ))}
          {more > 0 && (profileHref ? <a href={profileHref} className={styles.link}>{more} more {more === 1 ? "fact" : "facts"} on the profile &rarr;</a> : <span className={styles.muted}>{more} more {more === 1 ? "fact" : "facts"} not shown here</span>)}
        </>
      )}
    </>
  );
}
