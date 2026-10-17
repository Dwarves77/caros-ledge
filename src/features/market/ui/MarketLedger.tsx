"use client";

// Ported from old_repo/src/components/market/MarketIntelLedger.tsx (lines 29-355)
// The /market list on the one list surface: band tiles, signal-kind, mode and region facets with live counts, three sorts, grouped or flat, five rows a band then "All N". EVERY control lives in the URL (kind, sort and the flat view
// included, so a filtered view can be linked). The headline card, the rail and the foot are slots the server page fills.
import { useMemo, useState, type ReactNode } from "react";

import { BAND_ORDER, bandFromPriority, toListRowFields, type UrgencyBandKey } from "@/core/lists";
import { formatLocaleDate, formatNumber } from "@/core/shared";
import type { Resource } from "@/core/types";
import type { WorkspaceAggregates } from "@/features/lists";
import { useTagsFacet } from "@/features/regulations/useTagsFacet";
import { RowWatch } from "@/features/watchlist/ui/RowActions";
import { Menu, StateNote, Toast } from "@/ui";
import { filterRows, liveFacetCounts, sortResourceRows, useListUrlState, withListPosition, ListSurface, SortRow, type FacetGroup, type ListSortKey } from "@/ui/list-surface";
import { ShellCommandBar } from "@/ui/shell";

import { RetryNote } from "./RetryNote";

const PER_BAND_CAP = 5;
const LIST = "market";
const SORTS: Array<{ key: ListSortKey; label: string }> = [
  { key: "next-date", label: "Next date" },
  { key: "newest", label: "Newest" },
  { key: "az", label: "A-Z" },
];
const KIND_LABEL: Record<string, string> = { action_required: "Action required", cost_alert: "Cost alert", window_closing: "Window closing", competitive_edge: "Competitive edge", monitoring: "Monitoring" };
/** The signal kind is the classified `severity` column; a row it was never classified for has no kind (no keyword guess). */
const kindOf = (r: Resource): string | null => (r.severity ? (KIND_LABEL[r.severity] ?? null) : null);

export interface MarketLedgerProps {
  resources: Resource[];
  aggregates: WorkspaceAggregates | null;
  /** The request's one instant. */
  nowIso: string;
  /** The signal read failed: the list says so with Retry (INV-263), never an empty list and never a zero. */
  failed?: boolean;
  /** Observed series on the board; null when the board did not load (the segment drops, it is not a 0). */
  seriesCount: number | null;
  headline: ReactNode;
  rail: ReactNode;
  belowRows: ReactNode;
}

function RowMenu({ id, href, onResult }: { id: string; href: string; onResult: (message: string, ok: boolean) => void }) {
  return (
    <Menu
      label="Signal actions"
      extra={<RowWatch type="signal" id={id} />}
      items={[
        {
          key: "copy",
          label: "Copy link",
          onSelect: () => {
            const url = new URL(href, window.location.origin).href;
            void (navigator.clipboard?.writeText(url).then(() => onResult("Link copied", true), () => onResult("Copy failed. Copy the address from the browser bar.", false)) ?? onResult("Copy failed. Copy the address from the browser bar.", false));
          },
        },
      ]}
    />
  );
}

export function MarketLedger({ resources, aggregates, failed = false, nowIso, seriesCount, headline, rail, belowRows }: MarketLedgerProps) {
  const url = useListUrlState(["kind", "flat"]);
  const { filter, setFacet, toggleFacet, setSort, setExtra } = url;
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const kind = url.extras.kind ?? null;
  const flat = url.extras.flat === "1";
  const sortKey: ListSortKey = url.sort && SORTS.some((s) => s.key === url.sort) ? url.sort : "next-date";
  const [expanded, setExpanded] = useState<Set<UrgencyBandKey>>(new Set());
  const tagsFacet = useTagsFacet();
  const matchesTag = tagsFacet.matches;
  const [toast, setToast] = useState<{ message: string; ok: boolean } | null>(null);

  const withKind = useMemo(() => (kind ? resources.filter((r) => kindOf(r) === kind) : resources), [resources, kind]);
  const counts = useMemo(() => liveFacetCounts(withKind, filter, kind ? {} : { byPriority: aggregates?.byPriority as never, byJurisdiction: aggregates?.byJurisdiction ?? {}, totalItems: aggregates?.totalItems ?? 0 }), [withKind, filter, kind, aggregates]);
  const kindOptions = useMemo(() => {
    const tally = new Map<string, number>();
    for (const r of filterRows(resources, filter)) {
      const k = kindOf(r);
      if (k) tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    return [...tally].map(([value, count]) => ({ value, label: value, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [resources, filter]);
  const facetGroups: FacetGroup[] = [
    { key: "kind", label: "Signal kind", options: kindOptions, selected: kind, onSelect: (v) => setExtra("kind", v) },
    { key: "mode", label: "Mode", options: counts.mode, selected: filter.mode, onSelect: (v) => setFacet("mode", v) },
    { key: "region", label: "Region", options: counts.region, selected: filter.region, onSelect: (v) => setFacet("region", v) },
  ];

  const sorted = useMemo(() => sortResourceRows(filterRows(withKind, { ...filter, band: null }).filter((r) => matchesTag(r.id)), sortKey, now), [withKind, filter, sortKey, now, matchesTag]);
  const tagGroup: FacetGroup = { key: "workspace-tags", label: "Workspace tags", options: tagsFacet.tags.map((t) => ({ value: t.id, label: t.name, count: t.itemCount })), selected: tagsFacet.selected, onSelect: tagsFacet.setSelected };
  const rowsByBand = BAND_ORDER.map((band) => {
    const inBand = filter.band && filter.band !== band.key ? [] : sorted.filter((r) => bandFromPriority(r.priority).key === band.key);
    return {
      band,
      total: inBand.length,
      rows: inBand.map((r, i) => {
        const f = toListRowFields(r, now);
        const kindLabel = kindOf(r);
        const href = withListPosition(f.href, LIST, i + 1, inBand.length, { prev: inBand[i - 1]?.id ?? null, next: inBand[i + 1]?.id ?? null });
        return {
          key: r.id,
          href,
          band,
          jurisdiction: f.jurisdiction,
          title: f.title,
          meta: f.meta,
          ...(kindLabel ? { kind: kindLabel } : {}),
          impact: f.impact,
          due: f.due,
          timeline: f.timeline,
          tier: f.tier,
          ...(f.biasTags ? { biasTags: f.biasTags } : {}),
          itemGrade: f.itemGrade,
          overflow: <RowMenu id={r.id} href={f.href} onResult={(message, ok) => setToast({ message, ok })} />,
        };
      }),
    };
  });
  const bandCounts = Object.fromEntries(counts.band.map((o) => [o.key, o.count])) as Record<UrgencyBandKey, number>;
  const total = counts.total;

  return (
    <>
      <ListSurface
        title="Market Intelligence"
        dek={
          <span data-audit="scope-line">
            {failed ? "Signals unavailable" : <><b>{formatNumber(total)}</b> active signals</>}
            {seriesCount !== null && (
              <>
                {" · "}
                <b>{formatNumber(seriesCount)}</b> observed series
              </>
            )}
          </span>
        }
        dateLabel={formatLocaleDate(now, { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}
        nowIso={nowIso}
        commandBar={<ShellCommandBar />}
        bandCounts={failed ? null : bandCounts}
        {...(failed ? { emptyState: <RetryNote what="Market signals" /> } : {})}
        selectedBand={filter.band}
        onSelectBand={(key) => toggleFacet("band", key)}
        facetGroups={facetGroups}
        secondaryFacetGroups={[tagGroup]}
        {...(tagsFacet.failed ? { stateNote: <StateNote tone="error" action={{ label: "Retry", onClick: tagsFacet.retry }}>Your workspace tags did not load.</StateNote> } : {})}
        aboveRows={headline}
        sortRow={
          <SortRow
            countLabel={
              <>
                <b>{formatNumber(total)}</b> signals · {flat ? "flat" : "grouped by band"}
              </>
            }
            linkLabel={flat ? "Group by band" : "Show as one list"}
            onLink={() => setExtra("flat", flat ? null : "1")}
            controlLabel="Sort"
            options={SORTS}
            active={sortKey}
            onSelect={(k) => setSort(k as ListSortKey)}
          />
        }
        flat={flat}
        rowsByBand={rowsByBand}
        perBandCap={PER_BAND_CAP}
        expandedBands={expanded}
        onExpandBand={(key) => setExpanded((s) => new Set(s).add(key))}
        rail={rail}
        belowRows={belowRows}
      />
      <Toast message={toast?.message ?? ""} visible={toast !== null} variant={toast?.ok === false ? "error" : "success"} onDismiss={() => setToast(null)} />
    </>
  );
}
