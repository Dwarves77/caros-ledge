"use client";

// Ported from old_repo/src/components/search/SearchResultsView.tsx (lines 16-105)
import { useRouter } from "next/navigation";

import { bandFromPriority, detailHref, jurisdictionCode, metaLine } from "@/core/lists";
import { formatNumber } from "@/core/shared";
import { ListRow, ListRowHeader, Masthead, SectionCard, SectionHead, StateNote } from "@/ui";
import { PageFrame, ShellCommandBar } from "@/ui/shell";
import { LegendRailCard } from "@/ui/list-surface";

import type { SearchOutcome, SearchRow } from "../types";

/** The results page body. Three honest states: the rows (with their source rating), no match, and a failed read with Retry; the cap is stated when the list reaches it. */
export function SearchResultsView({ q, outcome, maxResults, dateLabel, nowIso }: { q: string; outcome: SearchOutcome<SearchRow>; maxResults: number; dateLabel: string; nowIso: string }) {
  const router = useRouter();
  const rows = outcome.ok ? outcome.rows : [];
  return (
    <>
      <div className="cl-list-surface-masthead">
        <Masthead title="Search" dateLabel={dateLabel} nowIso={nowIso} dek={q ? <>Results for &ldquo;{q}&rdquo;</> : <>Search or ask across the workspace</>} commandBar={<ShellCommandBar />} />
      </div>
      <PageFrame rail={<LegendRailCard />}>
        <SectionCard>
          <SectionHead title={q && outcome.ok ? `Results · ${formatNumber(rows.length)}` : "Search"} />
          {!outcome.ok ? (
            <div className="cl-pad-16">
              <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>
                Search is unavailable right now. Nothing was lost; try again.
              </StateNote>
            </div>
          ) : !q ? (
            <div className="cl-pad-16">
              <StateNote>Type a search in the bar above and press Enter, or use its Ask button to ask a question instead.</StateNote>
            </div>
          ) : rows.length === 0 ? (
            <div className="cl-pad-16">
              <StateNote>No results for &ldquo;{q}&rdquo;.</StateNote>
            </div>
          ) : (
            <>
              {rows.length >= maxResults && (
                <div className="cl-pad-16">
                  <StateNote>Showing the top {formatNumber(maxResults)} matches. Narrow the search to see more precise results.</StateNote>
                </div>
              )}
              <ListRowHeader titleLabel="Title · type · modes" />
              {rows.map((r) => (
                <ListRow key={r.id} href={detailHref({ id: r.id, type: r.item_type, domain: r.domain })} band={bandFromPriority(r.priority)} jurisdiction={jurisdictionCode({ jurisdiction: r.jurisdictions?.[0] ?? undefined })} title={r.title} meta={metaLine({ type: r.item_type, modes: r.transport_modes ?? undefined, topic: r.topic ?? undefined })} tier={r.tier} />
              ))}
            </>
          )}
        </SectionCard>
      </PageFrame>
    </>
  );
}
