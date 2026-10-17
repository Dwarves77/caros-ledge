"use client";

// Ported from old_repo/src/components/research/ResearchLedger.tsx (lines 30-480)
// Ported from old_repo/src/app/research/page.tsx (lines 98-134)
// The Research list on the shared list surface: urgency bands, the Mode and Region facets, the theme facet row and the window sort (both in the URL, so a view can be linked), a horizon band in each row's meta,
// the source coverage and legend rail cards. Every count comes from the corpus tallies at rest and from the rows under a selection; a failed read is said, with Retry, never an empty list (INV-263).
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState, type ReactNode } from "react";

import { BAND_ORDER, bandFromPriority, type UrgencyBandKey } from "@/core/lists";
import { formatLocaleDate, formatNumber } from "@/core/shared";
import { BiasLegend, CoverageState, ErrorState, isImpactScored, RailCard, StateNote } from "@/ui";
import { filterRows, LegendRailCard, liveFacetCounts, ListSurface, SortRow, ThemeStrip, useListUrlState, type FacetGroup, type ListWindowKey, type ThemeChip } from "@/ui/list-surface";
import { filterByWindow, WINDOW_OPTIONS } from "@/ui/list-surface/filter-sort";
import { ShellCommandBar } from "@/ui/shell/CommandBar";
import { DenominatorLine } from "@/features/coverage/ui/DenominatorLine";
import { useTagsFacet } from "@/features/regulations/useTagsFacet";

import { horizonMetaLabel } from "../model/assessment-view";
import { NEW_WINDOW_DAYS, SEVERITY_LABELS, severityOf, THEME_KEYS, themeLabel, themeOf } from "../model/taxonomy";
import { UNCLASSIFIED } from "../theme-rules";
import type { ResearchPageData } from "../read/research-reads";

import { CredibilityChips } from "./CredibilityChips";
import styles from "./research.module.css";
import { bandedRows } from "./rows";
import { ThemeFacetRow } from "./ThemeFacetRow";

const PER_BAND_CAP = 5;
const PLACEHOLDER = 'Search findings and themes - or ask "what affects my FY26 Scope 3 baseline?"';
type DenominatorProps = Parameters<typeof DenominatorLine>[0];

export interface ResearchListProps {
  data: ResearchPageData;
  /** The request's one instant: every date and window on the page is measured from it. */
  nowIso: string;
  chips: ThemeChip[];
  denominator: DenominatorProps;
  /** The theme strip's own read failed. */
  chipsFailed?: boolean;
}

export function ResearchList({ data, nowIso, chips, denominator, chipsFailed = false }: ResearchListProps) {
  const router = useRouter();
  const url = useListUrlState(["theme"]);
  const tagsFacet = useTagsFacet();
  const matchesTag = tagsFacet.matches;
  const [expanded, setExpanded] = useState<Set<UrgencyBandKey>>(new Set());
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const { filter } = url;
  const windowKey: ListWindowKey = url.window ?? "all";
  const theme = url.extras.theme ?? null;
  const rows = data.rows;
  const aggregates = data.aggregates;

  // Everything except the theme facet: the pills count off this, so choosing one theme never zeroes the others.
  const beforeTheme = useMemo(() => filterByWindow(filterRows(rows, filter), windowKey, now).filter((r) => matchesTag(r.id)), [rows, filter, windowKey, now, matchesTag]);
  const filtered = useMemo(() => (theme === UNCLASSIFIED ? beforeTheme.filter((r) => !themeOf(r)) : theme ? beforeTheme.filter((r) => themeOf(r) === theme) : beforeTheme), [beforeTheme, theme]);
  const counts = useMemo(() => liveFacetCounts(rows, filter, { ...(aggregates ? { byPriority: aggregates.byPriority as unknown as Record<string, number>, byJurisdiction: aggregates.byJurisdiction, totalItems: aggregates.totalItems } : {}) }), [rows, filter, aggregates]);
  const bandCounts = data.rowsFailed ? null : (Object.fromEntries(counts.band.map((o) => [o.key, o.count])) as Record<UrgencyBandKey, number>);

  const pills = useMemo(() => {
    const tally = new Map<string, number>();
    const fresh = new Map<string, number>();
    const cutoff = now.getTime() - NEW_WINDOW_DAYS * 86_400_000;
    for (const r of beforeTheme) {
      const key = themeOf(r);
      if (!key) continue;
      tally.set(key, (tally.get(key) ?? 0) + 1);
      const added = r.added ? new Date(r.added).getTime() : NaN;
      if (!Number.isNaN(added) && added >= cutoff) fresh.set(key, (fresh.get(key) ?? 0) + 1);
    }
    return THEME_KEYS.filter((k) => tally.has(k)).map((k) => ({ key: k, count: tally.get(k) ?? 0, newCount: fresh.get(k) ?? 0 }));
  }, [beforeTheme, now]);
  const unclassified = useMemo(() => beforeTheme.filter((r) => !themeOf(r)).length, [beforeTheme]);

  const facetGroups: FacetGroup[] = [
    { key: "mode", label: "Mode", options: counts.mode, selected: filter.mode, onSelect: (v) => url.setFacet("mode", v) },
    { key: "region", label: "Region", options: counts.region, selected: filter.region, onSelect: (v) => url.setFacet("region", v) },
  ];
  const tagGroup: FacetGroup = { key: "workspace-tags", label: "Workspace tags", options: tagsFacet.tags.map((t) => ({ value: t.id, label: t.name, count: t.itemCount })), selected: tagsFacet.selected, onSelect: tagsFacet.setSelected };
  const assessments = data.assessments;
  const rowsByBand = useMemo(
    () =>
      bandedRows(filtered, {
        list: "research", menuLabel: "Research item actions", bandKey: filter.band, now,
        meta: (r) => [r.type, themeOf(r) ? themeLabel(themeOf(r) as string) : null, r.sub || (r.modes ?? []).join(", "), horizonMetaLabel(assessments?.[r.id])].filter(Boolean).join(" · "),
        kind: (r) => (r.severity ? SEVERITY_LABELS[severityOf([r.title, r.whatIsIt, r.whyMatters].filter(Boolean).join(" "), r.added, r.severity, now)] : undefined),
      }),
    [filtered, filter.band, now, assessments],
  );
  const awarenessNote = useMemo(() => filtered.filter((r) => bandFromPriority(r.priority).key === "awareness" && !isImpactScored(r.impactScores)).length, [filtered]);
  const total = counts.total;
  const windowDays = WINDOW_OPTIONS.find((o) => o.key === windowKey)?.days ?? null;
  const wider = WINDOW_OPTIONS.find((o) => windowDays !== null && (o.days === null || o.days > windowDays));
  const coverageByMode = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of data.coverage ?? []) m.set(c.transportMode, (m.get(c.transportMode) ?? 0) + c.sourceCount);
    return [...m];
  }, [data.coverage]);

  if (data.rowsFailed) return <ErrorState title="Research did not load" message="The findings could not be read just now. Try again; nothing was changed." onRetry={() => router.refresh()} />;
  const tail: ReactNode = (
    <div className={styles.below}>
      {chipsFailed ? <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>The theme strip did not load.</StateNote> : <ThemeStrip chips={chips} />}
      <DenominatorLine {...denominator} />
      <div className={styles.credRow}>
        <span className={styles.credLabel}>Credibility model</span>
        <CredibilityChips />
        <span className={styles.fine}>Two scores, never merged. Open a chip for its detail.</span>
      </div>
      <BiasLegend />
      {assessments === null && <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>Horizon assessments did not load, so rows carry no horizon band.</StateNote>}
    </div>
  );
  return (
    <ListSurface
      title="Research"
      dek={<><b>{formatNumber(total)}</b> active findings · <b>{pills.length}</b> themes · peer-reviewed journals, think tanks, quantified-climate research, analytical press</>}
      dateLabel={formatLocaleDate(now, { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}
      nowIso={nowIso}
      commandBar={<ShellCommandBar placeholder={PLACEHOLDER} />}
      bandCounts={bandCounts}
      selectedBand={filter.band}
      onSelectBand={(key) => url.toggleFacet("band", key)}
      facetGroups={facetGroups}
      stateNote={tagsFacet.failed ? <StateNote tone="error" action={{ label: "Retry", onClick: tagsFacet.retry }}>Your workspace tags did not load.</StateNote> : undefined}
      secondaryFacetGroups={[tagGroup]}
            aboveRows={<ThemeFacetRow themes={pills} selected={theme} onSelect={(k) => url.setExtra("theme", k)} unclassifiedCount={unclassified} />}
      sortRow={
        <SortRow
          countLabel={<><b>{formatNumber(filtered.length)} of {formatNumber(total)}</b> findings{theme ? ` · ${themeLabel(theme)}` : ""}</>}
          {...(theme ? { linkLabel: "Clear theme", onLink: () => url.setExtra("theme", null) } : {})}
          controlLabel="Window"
          options={WINDOW_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
          active={windowKey}
          onSelect={(k) => url.setWindow(k === "all" ? null : (k as ListWindowKey))}
        />
      }
      rowsByBand={rowsByBand}
      perBandCap={PER_BAND_CAP}
      expandedBands={expanded}
      onExpandBand={(key) => setExpanded((s) => new Set(s).add(key))}
      sectionFoot={(_band, next) =>
        next === "awareness" && awarenessNote > 0 ? (
          <StateNote band={BAND_ORDER.find((b) => b.key === "awareness") ?? null} action={{ label: "How impact is read →", href: "#research-legend" }}>
            <b>Awareness</b> · {awarenessNote} findings carry no impact inputs yet and are kept for context
          </StateNote>
        ) : null
      }
      emptyState={
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>{windowDays === null ? "Nothing matches this selection" : `Nothing in the last ${windowDays} days`}</div>
          <div className={styles.emptyText}>
            0 of {formatNumber(total)} findings match{theme ? ` ${themeLabel(theme)} · ` : " "}
            {WINDOW_OPTIONS.find((o) => o.key === windowKey)?.label ?? "All"}.{" "}
            {wider && (
              <>
                <button type="button" className={styles.windowLink} onClick={() => url.setWindow(wider.key === "all" ? null : wider.key)}>Widen to {wider.days ?? "all"} days</button>
                {theme ? " or " : "."}
              </>
            )}
            {theme && (
              <>
                <button type="button" className={styles.windowLink} onClick={() => url.setExtra("theme", null)}>clear the theme</button>.
              </>
            )}
          </div>
        </div>
      }
      belowRows={tail}
      rail={
        <Fragment>
          <RailCard title="Source coverage" dataAudit="source-coverage-rail">
            {data.coverage === null ? (
              <CoverageState state="error" variant="inline" subject="The source coverage matrix" onRetry={() => router.refresh()} />
            ) : coverageByMode.length === 0 ? (
              <CoverageState state="no_data_yet" variant="inline" subject="The source coverage matrix" reason="No coverage matrix has been populated yet." />
            ) : (
              <div className={styles.coverage}>
                {coverageByMode.map(([mode, count]) => (
                  <Fragment key={mode}>
                    <span>{mode}</span>
                    <span className={styles.coverageValue}>{formatNumber(count)}</span>
                  </Fragment>
                ))}
              </div>
            )}
            <p className={styles.fine}>Distribution across the transport modes the coverage matrix records.</p>
          </RailCard>
          <div id="research-legend">
            <LegendRailCard />
          </div>
        </Fragment>
      }
    />
  );
}
