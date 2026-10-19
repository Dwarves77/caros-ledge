"use client";

// Ported from old_repo/src/components/regulations/RegulationsLedger.tsx (lines 52-355)
// The Regulations list on the kit's ListSurface: band tiles that filter, grouped or flat rows, URL-backed facets (band, mode, jurisdiction, topic, source tier, workspace tags, search) and sort,
// the workspace's priority retag and dismiss with a restore stash, the scope line, the "Updated" chip within 30 days of a regenerated brief. The first page arrives with the page; the rest is
// fetched after paint and a failure of it is said (with Retry), never a short list. Saved views are the personal, per-user ones (IMP-064). Nothing reads the clock: `nowIso` is the request's.
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { BAND_ORDER, bandFromPriority, detailHref, dueInfo, jurisdictionCode, type UrgencyBandKey } from "@/core/lists";
import { rowMeta } from "@/features/market/lib/item-type";
import { formatLocaleDate, formatNumber } from "@/core/shared";
import type { WorkspaceAggregates } from "@/features/lists";
import { mergeWithOverrides, useItemStateStore } from "@/features/workspace/state";
import { requestJson } from "@/core/http/request-json";
import { StateNote } from "@/ui";
import { filterRows, liveFacetCounts, ListSurface, SortRow, sortResourceRows, ThemeStrip, useListRows, useListUrlState, withListPosition, type FacetGroup, type ListSortKey, type ThemeChip } from "@/ui/list-surface";
import { DetailWatch } from "@/features/workspace/ui/DetailWatch";
import { ShellCommandBar } from "@/ui/shell/CommandBar";
import { SavedViews } from "@/features/saved-views/SavedViews";

import { DismissedStash } from "./DismissedStash";
import { PriorityMenu } from "./PriorityMenu";
import type { LedgerRow } from "./list-read";
import { useTagsFacet } from "./useTagsFacet";

const PER_BAND_CAP = 5;
const SORTS: Array<{ key: ListSortKey; label: string }> = [
  { key: "next-date", label: "Next date" },
  { key: "newest", label: "Newest" },
  { key: "az", label: "A-Z" },
  { key: "my-order", label: "My order" },
];

async function fetchRest(): Promise<LedgerRow[]> {
  const r = await requestJson<{ resources?: LedgerRow[] }>("/api/listings/rest?surface=regulations");
  if (!r.ok) throw new Error(r.error ?? "the rest of the list did not load");
  return r.data?.resources ?? [];
}

/** `chips` is null when the theme strip's read failed; `degraded` are the sentences for reads that failed beside the list (profile, milestones, marks), each with Retry. */
export function RegulationsLedger({ initial, aggregates, hasMore, nowIso, chips, degraded = [], rail, below }: { initial: LedgerRow[]; aggregates: WorkspaceAggregates | null; hasMore: boolean; nowIso: string; chips: ThemeChip[] | null; degraded?: readonly string[]; rail: ReactNode; below?: ReactNode }) {
  const router = useRouter();
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const url = useListUrlState();
  const [expanded, setExpanded] = useState<Set<UrgencyBandKey>>(new Set());
  const [flat, setFlat] = useState(false);
  const sortKey = url.sort ?? "next-date";
  const remainder = useListRows<LedgerRow>(initial, fetchRest, hasMore);
  const overrides = useItemStateStore((s) => s.overrides);
  const personal = useItemStateStore((s) => s.personalState);
  const restore = useItemStateStore((s) => s.restoreDismissed);
  const tagsFacet = useTagsFacet();
  const { active, dismissed } = useMemo(() => mergeWithOverrides(remainder.rows, overrides, personal), [remainder.rows, overrides, personal]);
  const uuids = useMemo(() => new Map(remainder.rows.map((r) => [r.id, r.uuid])), [remainder.rows]);
  const tagged = (id: string) => tagsFacet.matches(uuids.get(id) ?? id);
  const filtered = useMemo(() => sortResourceRows(filterRows(active, url.filter).filter((r) => tagged(r.id)), sortKey, now), [active, url.filter, sortKey, now, tagsFacet.matches, uuids]); // eslint-disable-line react-hooks/exhaustive-deps -- `tagged` closes over matches and uuids
  const counts = useMemo(() => liveFacetCounts(active, url.filter, { ...(aggregates ? { byPriority: aggregates.byPriority as unknown as Record<string, number>, byJurisdiction: aggregates.byJurisdiction, totalItems: aggregates.totalItems } : {}) }), [active, url.filter, aggregates]);
  const bandCounts = aggregates ? (Object.fromEntries(counts.band.map((o) => [o.key, o.count])) as Record<UrgencyBandKey, number>) : null;

  const group = (key: string, label: string, options: FacetGroup["options"], selected: string | null, set: (v: string | null) => void): FacetGroup => ({ key, label, options, selected, onSelect: set });
  const facetGroups: FacetGroup[] = [
    group("mode", "Mode", counts.mode, url.filter.mode, (v) => url.setFacet("mode", v)),
    group("region", "Jurisdiction", counts.region, url.filter.region, (v) => url.setFacet("region", v)),
    group("topic", "Topic", counts.topic, url.filter.topic, (v) => url.setFacet("topic", v)),
    group("tier", "Source tier", counts.tier, url.filter.tier, (v) => url.setFacet("tier", v)),
  ];
  const tagGroup = group("workspace-tags", "Workspace tags", tagsFacet.tags.map((t) => ({ value: t.id, label: t.name, count: t.itemCount })), tagsFacet.selected, tagsFacet.setSelected);

  const rowsByBand = BAND_ORDER.map((band) => {
    const inBand = url.filter.band && url.filter.band !== band.key ? [] : filtered.filter((r) => bandFromPriority(r.priority).key === band.key);
    return {
      band,
      total: inBand.length,
      rows: inBand.map((r, i) => {
        const due = dueInfo(r, now);
        const days = Math.floor((now.getTime() - Date.parse(r.lastRegeneratedAt ?? "")) / 86_400_000);
        return {
          key: r.id,
          href: withListPosition(detailHref(r), "regulations", i + 1, inBand.length, { prev: inBand[i - 1]?.id ?? null, next: inBand[i + 1]?.id ?? null }),
          band,
          jurisdiction: jurisdictionCode(r),
          title: r.title,
          meta: rowMeta(r),
          ...(days >= 0 && days <= 30 ? { kind: `Updated ${formatLocaleDate(new Date(r.lastRegeneratedAt as string), { month: "short", day: "numeric", timeZone: "UTC" })}` } : {}),
          impact: r.impactScores ?? null,
          due: due ? { label: due.label, days: due.days } : null,
          timeline: r.timeline ?? null,
          tier: r.sourceTier ?? null,
          ...(r.biasTags && r.biasTags.length > 0 ? { biasTags: r.biasTags } : {}),
          ...(r.itemGrade ? { itemGrade: r.itemGrade } : {}),
          tags: tagsFacet.tagsFor(uuids.get(r.id) ?? r.id),
          overflow: <PriorityMenu itemId={r.id} title={r.title} priority={r.priority} top={<DetailWatch type="reg" id={r.id} />} />,
        };
      }),
    };
  });

  const total = counts.total;
  // The count is the list's only when the counts read answered, the first page was not the whole of it (no more to come), or the remainder has arrived; otherwise it is what is shown so far.
  const exact = aggregates !== null || !hasMore || remainder.state === "ready";
  const jurisdictions = counts.liveSelection ? counts.region.length : aggregates?.totalJurisdictions || counts.region.length;
  const next = useMemo(() => active.reduce<{ days: number; label: string; title: string } | null>((best, r) => (((d) => (d && (!best || d.daysNum < best.days) ? { days: d.daysNum, label: d.label, title: r.title } : best))(dueInfo(r, now))), null), [active, now]);
  const scope = [exact ? `${formatNumber(total)} active` : `${formatNumber(total)} shown, the list is longer`, `${formatNumber(jurisdictions)} jurisdictions`, aggregates?.lastUpdatedAt ? `last sync ${formatLocaleDate(new Date(aggregates.lastUpdatedAt), { month: "short", day: "numeric", timeZone: "UTC" })}` : null, next ? `next obligation ${next.label.replace(/, \d{4}$/, "")} · ${next.title}` : null].filter(Boolean).join(" · ");

  return (
    <ListSurface
      title="Regulations"
      dek={scope}
      dateLabel={formatLocaleDate(now, { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}
      nowIso={nowIso}
      commandBar={<ShellCommandBar placeholder="Search regulations, or ask about one" />}
      bandCounts={bandCounts}
      selectedBand={url.filter.band}
      onSelectBand={(key) => url.toggleFacet("band", key)}
      facetGroups={facetGroups}
      secondaryFacetGroups={[tagGroup]}
      aboveRows={
        <>
          {aggregates === null && (
            <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>
              The counts for this list did not load, so the band tiles and the facet totals are left blank.
            </StateNote>
          )}
          {degraded.map((note) => (
            <StateNote key={note} tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>
              {note}
            </StateNote>
          ))}
          {tagsFacet.failed && (
            <StateNote tone="error" action={{ label: "Retry", onClick: tagsFacet.retry }}>
              Your workspace tags did not load.
            </StateNote>
          )}
          <SavedViews surface="regulations" />
        </>
      }
      sortRow={
        <SortRow
          countLabel={
            <>
              <b style={{ color: "var(--ink)" }}>{formatNumber(total)}</b> regulations{exact ? "" : " shown"} · {flat ? "flat" : "grouped by band"}
            </>
          }
          linkLabel={flat ? "Group by band" : "Show as one list"}
          onLink={() => setFlat((f) => !f)}
          controlLabel="Sort"
          options={SORTS}
          active={sortKey}
          onSelect={(k) => url.setSort(k as ListSortKey)}
        />
      }
      flat={flat}
      rowsByBand={rowsByBand}
      perBandCap={PER_BAND_CAP}
      expandedBands={expanded}
      onExpandBand={(key) => setExpanded((s) => new Set(s).add(key))}
      loadingMoreRows={remainder.loadingMore}
      remainderFailed={remainder.failed}
      onRetryRemainder={remainder.retry}
      stateNote={remainder.loadingMore ? <StateNote>Loading the rest of the regulations in the background.</StateNote> : null}
      belowRows={
        <>
          {chips === null ? <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>The theme strip did not load.</StateNote> : <ThemeStrip chips={chips} />}
          {below}
          <DismissedStash dismissed={dismissed} onRestore={restore} />
        </>
      }
      rail={rail}
    />
  );
}
