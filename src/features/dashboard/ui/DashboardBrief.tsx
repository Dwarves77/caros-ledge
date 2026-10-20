"use client";

// Ported from old_repo/src/components/dashboard/DashboardBrief.tsx (lines 98-460)
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { BAND_ORDER, bandFromPriority } from "@/core/lists";
import { formatDate, formatNumber } from "@/core/shared";
import { CardFoot, ListRow, ListRowHeader, RailCard, SectionCard, SectionHead, SkeletonBandTile, StatBlock, StateNote, BandTile, BandTileRow } from "@/ui";
import { LegendRailCard, type ThemeChip } from "@/ui/list-surface";
import { PARAM } from "@/ui/list-surface/url-state";
import { PageFrame } from "@/ui/shell";
import type { WatchlistItem } from "@/features/watchlist/read/watchlist";
import { RowActions } from "@/features/watchlist/ui/RowActions";
import type { SourceCoverage } from "@/core/derived/source-coverage";

import { briefCardState, changeRowPrefix, SURFACES, type BriefRow } from "../rows";
import type { Counts } from "../read/digest";

import styles from "./dashboard.module.css";
import { CoverageLedgerCard } from "./CoverageLedgerCard";
import { WatchlistRailCard } from "./WatchlistRailCard";

export interface DashboardBriefProps {
  dueRows: BriefRow[];
  dueWindow: string;
  changedRows: BriefRow[];
  totalChanges: number;
  windowDays: number;
  auditDate: string;
  /** The row read failed (timed out or errored): both cards say so with Retry instead of drawing an empty list. */
  rowsFailed: boolean;
  ratingsFailed: boolean;
  /** Reads that failed beside the rows (profile, milestones, hold state): each is a sentence with Retry; the rows still draw. */
  degraded: readonly string[];
  /** null when the count reads failed. */
  counts: Counts | null;
  /** null when the watchlist read failed. */
  watchlist: WatchlistItem[] | null;
  themes: ThemeChip[];
  /** null when the source coverage read failed; absent when the caller reads none (a fixture), and then no coverage card is drawn. */
  coverage?: SourceCoverage | null;
}

const bandHref = (key: string) => `/regulations?${PARAM.band}=${key}`;

function Rows({ rows, prefix }: { rows: BriefRow[]; prefix: boolean }) {
  return (
    <>
      <ListRowHeader dueLabel="Due" />
      {rows.map((row) => {
        const lead = prefix ? changeRowPrefix(row) : null;
        const meta: ReactNode = lead ? `${lead}${row.meta ? ` · ${row.meta}` : ""}` : row.meta;
        return (
          <ListRow key={row.id} href={row.href} band={bandFromPriority(row.priority)} jurisdiction={row.jurisdiction} title={row.title} meta={meta} impact={row.impact} due={row.due} timeline={row.timeline} tier={row.tier} biasTags={row.biasTags ?? null} itemGrade={row.itemGrade} overflow={<RowActions title={row.title} type={row.watchType} id={row.id} />} />
        );
      })}
    </>
  );
}

/** The dashboard body: the band tiles, Due next, What changed, and the rail (Across the platform, themes, Watchlist, Portfolios, Legend). Every row links to its surface; every card has a rows state, an honest empty and a failed state with Retry. */
export function DashboardBrief(p: DashboardBriefProps) {
  const router = useRouter();
  const retry = () => router.refresh();
  const dueState = briefCardState(p.dueRows.length, p.rowsFailed);
  const changedState = briefCardState(p.changedRows.length, p.rowsFailed);
  const failure = (
    <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>
      The brief did not load. Nothing was changed; try again.
    </StateNote>
  );
  const by = p.counts?.regulations.byPriority;
  const surfaceCounts = p.counts?.surfaces ?? null;
  return (
    <PageFrame
      rail={
        <div className={styles.rail}>
          <SectionCard dataAudit="across-platform-card">
            <div className={styles.pad}>
              <p className={styles.eyebrow}>Across the platform</p>
              {surfaceCounts === null ? (
                <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>
                  Counts did not load.
                </StateNote>
              ) : (
                <div className={styles.stats}>
                  {SURFACES.map((s) => (
                    <Link key={s.key} href={s.href} prefetch={false} className={styles.stat}>
                      <StatBlock layout="row" label={s.label} note={s.note} value={formatNumber(surfaceCounts[s.key])} />
                    </Link>
                  ))}
                </div>
              )}
              {p.themes.length > 0 && (
                <div className={styles.themes}>
                  <p className={styles.eyebrow}>Connected across pages</p>
                  {p.themes.map((t) => (
                    <Link key={t.themeId} href={t.href} prefetch={false} title={t.itemTitle} className={styles.theme}>
                      <span data-guard-title className={styles.themeLabel}>
                        {t.label}
                      </span>
                      <span className={styles.themePages}>{t.pages.map((pg) => pg.label).join(" · ")}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </SectionCard>
          {p.coverage !== undefined && <CoverageLedgerCard coverage={p.coverage} />}
          <WatchlistRailCard items={p.watchlist} onRetry={retry} />
          <RailCard title="Portfolios" titleHref="/dashboard/portfolio" dataAudit="portfolio-rail-card">
            <p className={styles.note}>Items, corridors and entities your workspace holds together.</p>
          </RailCard>
          <LegendRailCard />
        </div>
      }
    >
      <div className={styles.column}>
        {p.degraded.map((note) => (
          <StateNote key={note} tone="error" action={{ label: "Retry", onClick: retry }}>
            {note}
          </StateNote>
        ))}
        {p.counts === null && (
          <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>
            The band counts did not load, so the tiles are blank rather than zero.
          </StateNote>
        )}
        <BandTileRow>{BAND_ORDER.map((band) => (by ? <BandTile key={band.key} band={band} count={by[band.priority]} href={bandHref(band.key)} /> : <SkeletonBandTile key={band.key} />))}</BandTileRow>

        <section>
          <SectionCard dataAudit="due-next-card">
            <SectionHead title={`Due next · ${p.dueRows.length} ${p.dueRows.length === 1 ? "item" : "items"}`} aside={p.dueWindow} />
            {dueState === "failed" ? (
              <div className="cl-pad-16">{failure}</div>
            ) : dueState === "empty" ? (
              <div className="cl-pad-16">
                <StateNote action={{ label: "Open the ledger →", href: "/regulations" }}>No item in this workspace&apos;s corpus carries a future binding date. Items appear here as they enter scope and are verified.</StateNote>
              </div>
            ) : (
              <>
                <Rows rows={p.dueRows} prefix={false} />
                <CardFoot left={by ? <>All {formatNumber(by.CRITICAL)} immediate</> : "All immediate"} leftHref={bandHref("immediate")} right={by ? <>then {formatNumber(by.HIGH)} action · {formatNumber(by.MODERATE)} monitor</> : ""} />
              </>
            )}
          </SectionCard>
        </section>

        <section>
          <SectionCard dataAudit="what-changed-card">
            <SectionHead title="What changed" aside={p.auditDate ? `Latest change ${formatDate(p.auditDate)}` : "No change on record"} />
            {p.ratingsFailed && p.changedRows.length + p.dueRows.length > 0 && (
              <div className="cl-pad-16">
                <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>
                  Source ratings did not load, so tiers are not shown on these rows.
                </StateNote>
              </div>
            )}
            {changedState === "failed" ? (
              <div className="cl-pad-16">{failure}</div>
            ) : changedState === "empty" ? (
              <div className="cl-pad-16">
                <StateNote>Nothing added or updated in the last {p.windowDays} days.</StateNote>
              </div>
            ) : (
              <>
                <Rows rows={p.changedRows} prefix />
                <CardFoot left={`All ${formatNumber(p.totalChanges)} changes in the last ${p.windowDays} days`} leftHref={`/regulations?${PARAM.sort}=newest`} right="New = added in this window · Updated = brief or timeline changed" />
              </>
            )}
          </SectionCard>
        </section>
      </div>
    </PageFrame>
  );
}
