"use client";

// Ported from old_repo/src/components/watchlist/WatchlistSurface.tsx (lines 1-474)
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { bandFromPriority, NEUTRAL_BAND } from "@/core/lists";
import { countNoun } from "@/core/shared";
import { CardFoot, ListRowHeader, RailCard, SectionHead, StateNote } from "@/ui";
import type { ListRowProps } from "@/ui/ListRow";
import { LegendRailCard, ListSurface, withListPosition, type FacetGroup } from "@/ui/list-surface";
import { ShellCommandBar } from "@/ui/shell";

import { WATCHLIST_TYPE_LABEL, type WatchlistItemType, type WatchlistScope } from "../links";
import type { NoticesRead } from "../read/notices";
import { byNextDate } from "../order";
import type { WatchlistItem, WatchlistRead } from "../read/watchlist";

import { NoticesCard } from "./NoticesCard";
import { RowActions } from "./RowActions";
import styles from "./watchlist.module.css";

const SCOPE_LABEL: Record<WatchlistScope, string> = { personal: "Personal", team: "Team" };
const LIST_KEY = "watchlist";
type Row = ListRowProps & { key: string };

export interface WatchlistSurfaceProps {
  /** null when the read failed. */
  watch: WatchlistRead | null;
  /** null when the notices read failed. */
  notices: NoticesRead | null;
  limit: number;
  dateLabel: string;
  nowIso: string;
}

function rowOf(item: WatchlistItem, position: number, total: number): Row {
  const f = item.fields;
  return {
    key: `${item.scope}:${item.type}:${item.id}`,
    ...(f ? { href: withListPosition(f.href, LIST_KEY, position, total) } : {}),
    band: bandFromPriority(f?.priority),
    itemType: f ? f.type : "reference",
    ...(f ? {} : { typeLabel: WATCHLIST_TYPE_LABEL[item.type] }),
    jurisdiction: f?.jurisdiction,
    title: item.title,
    summary: f?.summary,
    due: f?.due,
    tier: f?.tier,
    overflow: <RowActions title={item.title} type={item.type} id={item.id} />,
  };
}

/** /watchlist on the shared list surface: the Watched card (a head with the count and the order, the rows, the foot), the filters in the rail, the recalculation notices, the share note and the legend. */
export function WatchlistSurface({ watch, notices, limit, dateLabel, nowIso }: WatchlistSurfaceProps) {
  const router = useRouter();
  const [scope, setScope] = useState<WatchlistScope | null>(null);
  const [type, setType] = useState<WatchlistItemType | null>(null);
  const [query, setQuery] = useState("");
  const items = useMemo(() => watch?.items ?? [], [watch]);
  const personal = items.filter((i) => i.scope === "personal").length;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => (!scope || i.scope === scope) && (!type || i.type === type) && (!q || i.title.toLowerCase().includes(q) || (i.fields?.jurisdiction ?? "").toLowerCase().includes(q))).sort(byNextDate);
  }, [items, scope, type, query]);
  const rows = useMemo(() => visible.map((item, i) => rowOf(item, i + 1, visible.length)), [visible]);
  const clear = () => (setScope(null), setType(null), setQuery(""));

  const groups: FacetGroup[] = useMemo(() => {
    const out: FacetGroup[] = [];
    const scopes = (["personal", "team"] as const).map((s) => ({ value: s, label: SCOPE_LABEL[s], count: items.filter((i) => i.scope === s).length })).filter((o) => o.count > 0);
    if (scopes.length > 1) out.push({ key: "scope", label: "Scope", options: scopes, selected: scope, onSelect: (v) => setScope(v as WatchlistScope | null) });
    const types = [...new Set(items.map((i) => i.type))];
    if (types.length > 1) out.push({ key: "type", label: "Type", options: types.map((t) => ({ value: t, label: WATCHLIST_TYPE_LABEL[t], count: items.filter((i) => i.type === t).length })), selected: type, onSelect: (v) => setType(v as WatchlistItemType | null) });
    return out;
  }, [items, scope, type]);

  const retry = () => router.refresh();
  const changed = notices?.notices.length ?? 0;
  const emptyState = !watch ? (
    <div className="cl-pad-16">
      <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>
        Your watchlist did not load. Nothing was changed; try again.
      </StateNote>
    </div>
  ) : items.length === 0 ? (
    <div className="cl-pad-16">
      <StateNote action={{ label: "Browse what to watch →", href: "/regulations" }}>Nothing watched yet. Watch an item from its ⋯ menu on any list page, or the Watch button on a detail page, to follow it here.</StateNote>
    </div>
  ) : (
    <div className="cl-pad-16">
      <StateNote action={{ label: "Clear filters", onClick: clear }}>No watched items match these filters. You have {items.length} in total.</StateNote>
    </div>
  );

  return (
    <ListSurface
      title="Watchlist"
      dek={
        watch ? (
          <span data-audit="scope-line">
            <b>{personal}</b> watched · personal · <b>{items.length - personal}</b> shared by the workspace
          </span>
        ) : (
          "Your watched items and the workspace's"
        )
      }
      dateLabel={dateLabel}
      nowIso={nowIso}
      commandBar={<ShellCommandBar onSearch={setQuery} />}
      bands={false}
      bandCounts={null}
      selectedBand={null}
      onSelectBand={() => undefined}
      facetGroups={groups}
      flat
      rowsByBand={[{ band: NEUTRAL_BAND, rows, total: rows.length }]}
      perBandCap={rows.length}
      emptyState={emptyState}
      cardHead={
        <>
          <SectionHead title={watch ? `Watched · ${items.length}` : "Watched"} aside="Sorted by next date" />
          {watch?.capped && (
            <div className="cl-pad-16">
              <StateNote>Showing the most recent {limit} watched items per scope. Older watches exist but are not listed here.</StateNote>
            </div>
          )}
          {watch?.ratingsFailed && (
            <div className="cl-pad-16">
              <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>
                Source ratings did not load, so tiers are not shown on these rows.
              </StateNote>
            </div>
          )}
          {watch?.timelinesFailed && (
            <div className="cl-pad-16">
              <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>
                Milestone dates did not load for some rows, so their next dates are blank.
              </StateNote>
            </div>
          )}
          {rows.length > 0 && <ListRowHeader />}
        </>
      }
      cardFoot={
        <>
          <CardFoot left="Watch an item from its ⋯ menu on any list page, or the Watch button on a detail page." right="Browse regulations →" rightHref="/regulations" />
          {changed > 0 && (
            <div className={styles.strip} data-audit="changed-note">
              <StateNote band={bandFromPriority("HIGH")} action={{ label: "Review changes →", href: "#recalculation-notices" }}>
                <b>Action</b> · {countNoun(changed, "watched item")} recalculated in this window
              </StateNote>
            </div>
          )}
        </>
      }
      belowRows={<NoticesCard read={notices} onRetry={retry} />}
      rail={
        <>
          <RailCard title="Share with workspace" dataAudit="share-rail">
            <p className={styles.share}>A shared watchlist puts the same rows on every member&apos;s dashboard. Team-watch any row to add it.</p>
          </RailCard>
          <LegendRailCard />
        </>
      }
    />
  );
}
