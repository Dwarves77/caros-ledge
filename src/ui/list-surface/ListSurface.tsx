"use client";

// Ported from old_repo/src/components/list-surface/ListSurfaceShell.tsx (lines 64-633)
import { useMemo, useState, type ReactNode } from "react";

import { BAND_ORDER, type UrgencyBand, type UrgencyBandKey } from "@/core/lists";
import { formatNumber } from "@/core/shared";

import { BandGroupHeader, BandTile, BandTileRow } from "../BandParts";
import { Button } from "../Button";
import { FilterChip, FilterChipGroup } from "../Chips";
import { ListRow, type ListRowProps } from "../ListRow";
import { Masthead } from "../Masthead";
import { SectionCard } from "../SectionCard";
import { Sheet } from "../shell/Sheet";
import { SkeletonBandTile, SkeletonListRow } from "../Skeleton";
import { StateNote } from "../StateNote";

import { FiltersRailCard, type FacetGroup } from "./rail";
import { VirtualRows } from "./VirtualRows";

const VIRTUALIZE_ABOVE = 30;
const ROW_HEIGHT = 56;
type SectionRow = ListRowProps & { key: string };

export interface ListSurfaceProps {
  title: string;
  dek?: ReactNode;
  dateLabel: string;
  nowIso: string;
  /** The command bar for the masthead slot (the shell's ShellCommandBar). */
  commandBar?: ReactNode;
  /** False for a list with no band tiles (the watchlist). */
  bands?: boolean;
  /** null while loading or when the aggregates read failed: the tiles draw their skeleton, never 0. */
  bandCounts: Record<UrgencyBandKey, number> | null;
  selectedBand: UrgencyBandKey | null;
  onSelectBand: (key: UrgencyBandKey) => void;
  facetGroups: FacetGroup[];
  secondaryFacetGroups?: FacetGroup[];
  aboveRows?: ReactNode;
  sortRow?: ReactNode;
  flat?: boolean;
  /** `total` is null while the list is part-read and the corpus figure is not known: the header says "showing N" with no total, and the band has no "All N" button (INV-263 applies to counts). */
  rowsByBand: Array<{ band: UrgencyBand; rows: SectionRow[]; total: number | null }>;
  perBandCap: number;
  onExpandBand?: (key: UrgencyBandKey) => void;
  expandedBands?: Set<UrgencyBandKey>;
  loadingFirstPage?: boolean;
  loadingMoreRows?: boolean;
  /** The remainder read failed: the surface says so and offers Retry; it never presents the first page as the whole list (INV-263). */
  remainderFailed?: boolean;
  /** The remainder's state, drawn as `data-list-state` on the list root so a reader (and the parity capture) can tell a settled list from a loading one. "idle": there is no remainder. */
  listState?: "idle" | "loading" | "ready" | "failed";
  onRetryRemainder?: () => void;
  emptyState?: ReactNode;
  /** One titled card around the rows (or the empty state), with a head above and a foot below: the watchlist's Watched card. Rows are flat inside it. */
  cardHead?: ReactNode;
  cardFoot?: ReactNode;
  stateNote?: ReactNode;
  sectionFoot?: (bandKey: UrgencyBandKey, nextBandKey: UrgencyBandKey | null) => ReactNode;
  belowRows?: ReactNode;
  rail?: ReactNode;
}

function Rows({ rows }: { rows: SectionRow[] }) {
  const one = (row: SectionRow) => {
    const { key, ...rest } = row;
    return <ListRow key={key} {...rest} />;
  };
  return rows.length > VIRTUALIZE_ABOVE ? <VirtualRows rows={rows} rowHeight={ROW_HEIGHT} getRowId={(r) => r.key} renderRow={(r) => one(r)} /> : <>{rows.map(one)}</>;
}

function FilterSheet({ open, onClose, groups }: { open: boolean; onClose: () => void; groups: FacetGroup[] }) {
  return (
    <Sheet open={open} onClose={onClose} title="Filters" side="bottom">
      <div className="cl-filter-sheet">
        {groups.map((g) => (
          <div key={g.key} className="cl-filter-sheet-group">
            <FilterChipGroup label={g.label}>
              <FilterChip active={g.selected === null} onClick={() => g.onSelect(null)}>
                All
              </FilterChip>
              {g.options.map((o) => (
                <FilterChip key={o.value} active={g.selected === o.value} onClick={() => g.onSelect(o.value)}>
                  {o.label}
                  {(o.countLabel ?? formatNumber(o.count)) !== "" && ` · ${o.countLabel ?? formatNumber(o.count)}`}
                </FilterChip>
              ))}
            </FilterChipGroup>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

const transition = (sections: Array<{ band: UrgencyBand; total: number | null }>, i: number): string => {
  const next = sections[i + 1];
  return next ? `then ${next.band.label}${next.total === null ? "" : ` · ${formatNumber(next.total)}`}` : "end of list";
};

/**
 * THE list surface every ledger mounts: masthead, band tiles, the mobile facet strip and Filters sheet, rows grouped by band or flat (virtualized past 30),
 * the band foot and the slots, inside PageFrame's grid. The rail carries the FILTERS card first, then the surface's own rail. Its CSS is base.css, once.
 */
export function ListSurface(p: ListSurfaceProps) {
  const [sheet, setSheet] = useState(false);
  const groups = useMemo(() => [...p.facetGroups, ...(p.secondaryFacetGroups ?? [])], [p.facetGroups, p.secondaryFacetGroups]);
  const sections = useMemo(() => p.rowsByBand.filter((s) => (s.total === null ? s.rows.length > 0 : s.total > 0)), [p.rowsByBand]);
  const anyRows = p.rowsByBand.some((s) => s.rows.length > 0);
  const flatRows = useMemo(() => p.rowsByBand.flatMap((s) => s.rows), [p.rowsByBand]);
  return (
    <>
      <div className="cl-list-surface-masthead">
        <Masthead title={p.title} dek={p.dek} dateLabel={p.dateLabel} nowIso={p.nowIso} commandBar={p.commandBar} />
      </div>
      <div data-list-state={p.listState ?? "idle"} className={`cl-list-surface-grid${groups.length > 0 ? " cl-list-surface-grid--mobile-facets" : ""}`}>
        <div className="cl-list-surface-col">
          {p.bands !== false && (
            <BandTileRow>
              {BAND_ORDER.map((band) => (p.loadingFirstPage ? <SkeletonBandTile key={band.key} /> : <BandTile key={band.key} band={band} count={p.bandCounts ? (p.bandCounts[band.key] ?? 0) : null} selected={p.selectedBand === band.key} onSelect={() => p.onSelectBand(band.key)} />))}
            </BandTileRow>
          )}
          {groups.length > 0 && (
            <>
              <div className="cl-facets-mobile" data-guard-strip="true">
                {groups.map((g) => (
                  <FilterChipGroup key={g.key} label={g.label}>
                    <FilterChip active={g.selected === null} onClick={() => g.onSelect(null)}>
                      All
                    </FilterChip>
                    {g.options.map((o) => (
                      <FilterChip key={o.value} active={g.selected === o.value} onClick={() => g.onSelect(o.value)}>
                        {o.label}
                      </FilterChip>
                    ))}
                  </FilterChipGroup>
                ))}
              </div>
              <Button className="cl-filters-btn" onClick={() => setSheet(true)}>
                Filters
              </Button>
              <FilterSheet open={sheet} onClose={() => setSheet(false)} groups={groups} />
            </>
          )}
          {p.aboveRows}
          {p.sortRow}
          {p.loadingFirstPage ? (
            <SectionCard>
              {Array.from({ length: 15 }, (_, i) => (
                <SkeletonListRow key={i} />
              ))}
            </SectionCard>
          ) : p.cardHead ? (
            <SectionCard>
              {p.cardHead}
              {anyRows ? <Rows rows={flatRows} /> : p.emptyState}
              {p.cardFoot}
            </SectionCard>
          ) : !anyRows ? (
            <SectionCard>
              {p.emptyState ?? (
                <div className="cl-pad-16">
                  <StateNote>Nothing matches these filters right now.</StateNote>
                </div>
              )}
            </SectionCard>
          ) : p.flat ? (
            <SectionCard suppressRuleForBandGrouping>
              <Rows rows={flatRows} />
            </SectionCard>
          ) : (
            sections.map((s, i) => {
              const expanded = p.expandedBands?.has(s.band.key) ?? false;
              const visible = s.rows.slice(0, expanded ? s.rows.length : p.perBandCap);
              const foot = p.sectionFoot?.(s.band.key, sections[i + 1]?.band.key ?? null);
              return (
                <SectionCard key={s.band.key} suppressRuleForBandGrouping>
                  <BandGroupHeader band={s.band} right={<span className="cl-band-showing">{s.total === null ? `showing ${formatNumber(visible.length)}${p.listState === "failed" ? "" : " · loading the rest"}` : `showing ${formatNumber(visible.length)} of ${formatNumber(s.total)}`}</span>} />
                  <Rows rows={visible} />
                  {p.loadingMoreRows && <SkeletonListRow />}
                  <div data-audit="band-foot" className="cl-band-foot">
                    {s.total !== null && s.total > visible.length && p.onExpandBand ? (
                      <button type="button" className="cl-band-foot-link" onClick={() => p.onExpandBand?.(s.band.key)}>
                        All {formatNumber(s.total)} {s.band.label.toLowerCase()} →
                      </button>
                    ) : (
                      <span />
                    )}
                    <span className="cl-band-foot-next">{transition(sections, i)}</span>
                  </div>
                  {foot ? <div className="cl-band-foot-slot">{foot}</div> : null}
                </SectionCard>
              );
            })
          )}
          {p.remainderFailed && anyRows && (
            <StateNote tone="error" {...(p.onRetryRemainder ? { action: { label: "Retry", onClick: p.onRetryRemainder } } : {})}>
              The rest of this list did not load. What is shown is the first {formatNumber(flatRows.length)} rows, not the whole list.
            </StateNote>
          )}
          {p.stateNote && anyRows && <div>{p.stateNote}</div>}
          {p.belowRows}
        </div>
        <div className="cl-list-surface-rail">
          <FiltersRailCard groups={groups} />
          {p.rail}
        </div>
      </div>
    </>
  );
}
