"use client";

// Ported from old_repo/src/components/operations/OperationsLedger.tsx (lines 42-566)
// Ported from old_repo/src/app/operations/page.tsx (lines 34-63)
// The Operations list on the shared list surface: the region by dimension matrix and the statements above the rows, the Region, Dimension and Mode facets (the rail's Region facet scopes the matrix's columns and the
// Dimension facet its rows), band-grouped region profiles, and the coverage-gap and recalculated-figure rail cards. A read that failed is said (with Retry) and never drawn as an empty matrix, a zero or a complete count.
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState, type ReactNode } from "react";

import type { UrgencyBandKey } from "@/core/lists";
import { formatLocaleDate, formatNumber } from "@/core/shared";
import { ErrorState, RailCard, StateNote } from "@/ui";
import { filterRows, LegendRailCard, liveFacetCounts, ListSurface, ThemeStrip, useListUrlState, type FacetGroup, type ThemeChip } from "@/ui/list-surface";
import { ShellCommandBar } from "@/ui/shell/CommandBar";
import { DenominatorLine } from "@/features/coverage/ui/DenominatorLine";

import { bandedRows } from "../../research/ui/rows";
import { dimensionLabel, DIMENSION_COUNT_WORD, DIMENSIONS } from "../model/dimensions";
import { regionsForItem } from "../model/region-resolve";
import { buildStatements } from "../model/statements";
import type { OperationsPageData } from "../read/operations-reads";

import styles from "./operations.module.css";
import { DerivedFigures } from "./Spec09Panels";
import { RegionMatrix } from "./RegionMatrix";
import { StatementsBlock } from "./StatementsBlock";

const PER_BAND_CAP = 5;
const PLACEHOLDER = 'Search regions and dimensions — or ask "warehouse labor rates, Singapore vs LA?"';

export interface OperationsListProps {
  data: OperationsPageData;
  nowIso: string;
  chips: ThemeChip[];
  denominator: Parameters<typeof DenominatorLine>[0];
  chipsFailed?: boolean;
}

export function OperationsList({ data, nowIso, chips, denominator, chipsFailed = false }: OperationsListProps) {
  const router = useRouter();
  const url = useListUrlState(["dimension"]);
  const { filter } = url;
  const [expanded, setExpanded] = useState<Set<UrgencyBandKey>>(new Set());
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const dimensionFilter = url.extras.dimension ?? null;
  const rows = data.rows;
  const roster = data.roster;

  const filtered = useMemo(() => filterRows(rows, filter), [rows, filter]);
  const counts = useMemo(() => liveFacetCounts(rows, filter, data.aggregates ? { byPriority: data.aggregates.byPriority as unknown as Record<string, number>, byJurisdiction: data.aggregates.byJurisdiction, totalItems: data.aggregates.totalItems } : {}), [rows, filter, data.aggregates]);
  const bandCounts = data.rowsFailed ? null : (Object.fromEntries(counts.band.map((o) => [o.key, o.count])) as Record<UrgencyBandKey, number>);

  // The dimension facet's count is real coverage: how many of the roster's regions hold at least one fact for it.
  const dimensionOptions = useMemo(() => DIMENSIONS.map((d) => {
    const sourced = new Set((data.facts ?? []).filter((f) => f.dimension === d.db).map((f) => f.regionCode)).size;
    return { value: d.db, label: dimensionLabel(d), count: sourced, countLabel: `${sourced}/${roster?.length ?? 0}` };
  }), [data.facts, roster]);
  const facetGroups: FacetGroup[] = [
    { key: "region", label: "Region", options: counts.region, selected: filter.region, onSelect: (v) => url.setFacet("region", v) },
    { key: "dimension", label: "Dimension", options: dimensionOptions, selected: dimensionFilter, onSelect: (v) => url.setExtra("dimension", v) },
    { key: "mode", label: "Mode", options: counts.mode, selected: filter.mode, onSelect: (v) => url.setFacet("mode", v) },
  ];

  const matrixRegions = useMemo(() => (roster ?? []).filter((r) => !filter.region || r.code === filter.region).map((r) => ({ key: r.code, label: r.label })), [roster, filter.region]);
  const matrixDimensions = useMemo(() => (dimensionFilter ? DIMENSIONS.filter((d) => d.db === dimensionFilter) : DIMENSIONS), [dimensionFilter]);
  const statements = useMemo(() => buildStatements({ facts: data.facts ?? [], regions: (roster ?? []).map((r) => ({ code: r.code, label: r.label, displayOrder: r.displayOrder })), dimensions: DIMENSIONS.map((d) => d.db) }), [data.facts, roster]);
  const statementNames = useMemo(() => Object.fromEntries(DIMENSIONS.map((d) => [d.db, dimensionLabel(d)])), []);
  // A region's own profile row is its first item the roster resolves to; a region with none gets no link rather than a dead href.
  const profileHrefByRegion = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of rows) {
      const region = regionsForItem((roster ?? []).map((x) => ({ code: x.code, isoCodes: x.isoCodes })), { jurisdictionIso: r.jurisdictionIso, jurisdiction: r.jurisdiction })[0];
      if (region && !out[region]) out[region] = `/operations/${encodeURIComponent(r.id)}`;
    }
    return out;
  }, [rows, roster]);
  const rowsByBand = useMemo(() => bandedRows(filtered, { list: "operations", menuLabel: "Operations item actions", bandKey: filter.band, now }), [filtered, filter.band, now]);
  const gaps = useMemo(() => {
    const sourced = new Map<string, Set<string>>();
    for (const f of data.facts ?? []) sourced.set(f.regionCode, (sourced.get(f.regionCode) ?? new Set<string>()).add(f.dimension));
    const out: Array<{ label: string; figure: string }> = [];
    if (data.stateCosts) out.push({ label: "US · sub-national", figure: `${new Set(data.stateCosts.map((s) => s.stateCode)).size} jurisdictions sourced` });
    for (const r of roster ?? []) {
      const n = sourced.get(r.code)?.size ?? 0;
      if (n < DIMENSIONS.length) out.push({ label: r.label, figure: `${n} of ${DIMENSIONS.length} sourced` });
    }
    return out;
  }, [data.facts, data.stateCosts, roster]);
  const jurisdictions = data.aggregates?.totalJurisdictions ?? new Set(rows.map((r) => r.jurisdiction).filter(Boolean)).size;
  const retry = () => router.refresh();

  if (data.rowsFailed) return <ErrorState title="Operations did not load" message="The regional profiles could not be read just now. Try again; nothing was changed." onRetry={retry} />;
  const failedReads = [!roster && "the region roster", roster && !data.facts && "the regional facts", roster && !data.coverage && "the coverage summary"].filter(Boolean);
  const above: ReactNode = (
    <>
      {failedReads.length > 0 && <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>The matrix is not shown: {failedReads.join(" and ")} did not load.</StateNote>}
      {roster && data.facts && <RegionMatrix regions={matrixRegions} dimensions={matrixDimensions} facts={data.facts} coverageRows={data.coverage ?? []} crossRefCounts={data.linkedRegulations} totalRegionCount={roster.length} profileHrefByRegion={profileHrefByRegion} />}
      {data.facts && roster && <StatementsBlock statements={statements.statements} droppedVerdicts={statements.droppedVerdicts} dimensionNames={statementNames} />}
    </>
  );
  return (
    <ListSurface
      title="Operations Intelligence"
      dek={<><b>{formatNumber(counts.total)}</b> active items · <b>{formatNumber(jurisdictions)}</b> jurisdictions · {DIMENSION_COUNT_WORD} dimensions per region · every fact carries a source and date</>}
      dateLabel={formatLocaleDate(now, { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}
      nowIso={nowIso}
      commandBar={<ShellCommandBar placeholder={PLACEHOLDER} />}
      bandCounts={bandCounts}
      selectedBand={filter.band}
      onSelectBand={(key) => url.toggleFacet("band", key)}
      facetGroups={facetGroups}
      aboveRows={above}
      rowsByBand={rowsByBand}
      perBandCap={PER_BAND_CAP}
      expandedBands={expanded}
      onExpandBand={(key) => setExpanded((s) => new Set(s).add(key))}
      belowRows={
        <div className={styles.detail}>
          {chipsFailed ? <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>The theme strip did not load.</StateNote> : <ThemeStrip chips={chips} />}
          <DenominatorLine {...denominator} />
        </div>
      }
      rail={
        <Fragment>
          <RailCard title="Coverage gaps" dataAudit="coverage-gaps-rail">
            {gaps.length > 0 && (
              <div className={styles.rail}>
                {gaps.map((g) => (
                  <div key={g.label} className={styles.railRow}>
                    <b>{g.label}</b>
                    <span className={styles.railFigure}>{g.figure}</span>
                  </div>
                ))}
              </div>
            )}
            <p className={styles.noteText}>A known gap, stated plainly. State-level cost facts are the first fills.</p>
          </RailCard>
          <DerivedFigures figures={data.derived} />
          <LegendRailCard />
        </Fragment>
      }
    />
  );
}
