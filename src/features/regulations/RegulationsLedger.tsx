"use client";

// Ported from old_repo/src/components/regulations/RegulationsLedger.tsx (lines 52-355)
// The Regulations list on the kit's ListSurface: band tiles that filter, grouped or flat rows, URL-backed facets (band, mode, jurisdiction, topic, source tier, workspace tags, search) and sort,
// the workspace's priority retag and dismiss with a restore stash, the scope line, the "Updated" chip within 30 days of a regenerated brief. The first page arrives with the page; the rest is
// fetched after paint and a failure of it is said (with Retry), never a short list. Saved views are the personal, per-user ones (IMP-064). Nothing reads the clock: `nowIso` is the request's.
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { BAND_ORDER, bandFromPriority, bandOf, detailHref, dueInfo, toListRowFields, type UrgencyBandKey } from "@/core/lists";
import { formatLocaleDate, formatNumber } from "@/core/shared";
import type { WorkspaceAggregates } from "@/features/lists";
import { mergeWithOverrides, useItemStateStore } from "@/features/workspace/state";
import { requestJson } from "@/core/http/request-json";
import { StateNote } from "@/ui";
import { filterRows, isFilterActive, liveFacetCounts, ListSurface, SortRow, sortResourceRows, ThemeStrip, useListRows, useListUrlState, withListPosition, type FacetGroup, type ListSortKey, type ThemeChip } from "@/ui/list-surface";
import { DetailWatch } from "@/features/workspace/ui/DetailWatch";
import { ShellCommandBar } from "@/ui/shell/CommandBar";
import { SavedViews } from "@/features/saved-views/SavedViews";

import { DismissedStash } from "./DismissedStash";
import { NextObligationLine } from "./NextObligationLine";
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
  // While the remainder is loading (or failed) the rows in hand are part of the list, so no count is drawn from them (INV-263): the corpus figures answer only a question that is the whole corpus (no filter but the band, no workspace tag),
  // and every other count is left undrawn until the rest arrives.
  const partial = remainder.state === "loading" || remainder.state === "failed";
  const corpusAnswers = aggregates !== null && !tagsFacet.selected && !isFilterActive({ ...url.filter, band: null });
  const known = (corpus: number | undefined, rows: number): number | null => (!partial ? rows : corpusAnswers && corpus !== undefined ? corpus : null);
  const bandCounts = aggregates && (!partial || corpusAnswers) ? (Object.fromEntries(BAND_ORDER.map((b) => [b.key, partial ? (aggregates.byPriority[b.priority] ?? 0) : (counts.band.find((o) => o.key === b.key)?.count ?? 0)])) as Record<UrgencyBandKey, number>) : null;
  const uncounted = (options: FacetGroup["options"]): FacetGroup["options"] => (partial ? options.map((o) => ({ ...o, countLabel: "" })) : options);

  const group = (key: string, label: string, options: FacetGroup["options"], selected: string | null, set: (v: string | null) => void): FacetGroup => ({ key, label, options, selected, onSelect: set });
  const facetGroups: FacetGroup[] = [
    group("mode", "Mode", uncounted(counts.mode), url.filter.mode, (v) => url.setFacet("mode", v)),
    group("region", "Jurisdiction", aggregates && !counts.liveSelection ? counts.region : uncounted(counts.region), url.filter.region, (v) => url.setFacet("region", v)),
    group("topic", "Topic", uncounted(counts.topic), url.filter.topic, (v) => url.setFacet("topic", v)),
    group("tier", "Source tier", uncounted(counts.tier), url.filter.tier, (v) => url.setFacet("tier", v)),
  ];
  const tagGroup = group("workspace-tags", "Workspace tags", tagsFacet.tags.map((t) => ({ value: t.id, label: t.name, count: t.itemCount })), tagsFacet.selected, tagsFacet.setSelected);

  const rowsByBand = BAND_ORDER.map((band) => {
    const inBand = url.filter.band && url.filter.band !== band.key ? [] : filtered.filter((r) => bandFromPriority(r.priority).key === band.key);
    return {
      band,
      total: known(url.filter.band && url.filter.band !== band.key ? 0 : aggregates?.byPriority[band.priority], inBand.length),
      rows: inBand.map((r, i) => {
        const fields = toListRowFields(r, now);
        return {
          key: r.id,
          href: withListPosition(detailHref(r), "regulations", i + 1, inBand.length, { prev: inBand[i - 1]?.id ?? null, next: inBand[i + 1]?.id ?? null }),
          band,
          itemType: fields.type,
          jurisdiction: fields.jurisdiction,
          title: r.title,
          summary: fields.summary,
          due: fields.due,
          tier: fields.tier,
          overflow: <PriorityMenu itemId={r.id} title={r.title} priority={r.priority} top={<DetailWatch type="reg" id={r.id} />} />,
        };
      }),
    };
  });

  // The list's count is the corpus figure for the question asked, or the rows once all have arrived; null while the rest loads and no figure answers (the scope line and the sort row then say so and draw no total).
  const total = known(url.filter.band ? aggregates?.byPriority[bandOf(url.filter.band).priority] : aggregates?.totalItems, counts.total);
  const jurisdictions = partial ? (corpusAnswers && !url.filter.band ? aggregates?.totalJurisdictions ?? null : null) : counts.liveSelection ? counts.region.length : aggregates?.totalJurisdictions || counts.region.length;
  const next = useMemo(() => active.reduce<{ days: number; label: string; title: string; href: string } | null>((best, r) => (((d) => (d && (!best || d.daysNum < best.days) ? { days: d.daysNum, label: d.label, title: r.title, href: detailHref(r) } : best))(dueInfo(r, now))), null), [active, now]);
  const scope = [total === null ? (remainder.state === "loading" ? "loading the full list" : "part of the list shown") : `${formatNumber(total)} active`, jurisdictions === null ? null : `${formatNumber(jurisdictions)} jurisdictions`, aggregates?.lastUpdatedAt ? `last sync ${formatLocaleDate(new Date(aggregates.lastUpdatedAt), { month: "short", day: "numeric", timeZone: "UTC" })}` : null].filter(Boolean).join(" · ");
  const dek = (
    <>
      {scope}
      {next && <NextObligationLine label={next.label} title={next.title} href={next.href} />}
    </>
  );

  return (
    <ListSurface
      title="Regulations"
      dek={dek}
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
              <b style={{ color: "var(--ink)" }}>{formatNumber(total ?? filtered.length)}</b> regulations{total === null ? " shown, the rest is loading" : ""} · {flat ? "flat" : "grouped by band"}
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
      listState={remainder.state}
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
