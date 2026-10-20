// Ported from old_repo/src/app/page.tsx (lines 17-142)
import { APP_DATA_TAG, cachedRead } from "@/core/cache";
import { userClient } from "@/core/db/clients";
import { formatLocaleDate } from "@/core/shared";
import { log } from "@/core/shared/log";
import { readWorkspaceProfile } from "@/core/workspace";
import { pageSession } from "@/features/account/server/page-session";
import { PageFailure } from "@/ui/shell/PageFailure";
import { readWatchlist, WATCHLIST_RAIL_LIMIT } from "@/features/watchlist/read/watchlist";
import { StateNote } from "@/ui";
import { PageFrame } from "@/ui/shell";
import { readSourceCoverage } from "@/core/derived/source-coverage";
import { readThemeChips } from "@/core/detail/cross-page-read";

import { readCounts, readDigest } from "./read/digest";
import { buildChangedRows, buildDueNextRows, computeAuditDate, dueNextWindowLabel, firstTokenOf, surfaceItemTotal } from "./rows";
import { DashboardBrief } from "./ui/DashboardBrief";
import { DashboardMasthead } from "./ui/DashboardMasthead";

const REVALIDATE_SECONDS = 60;

const settle = async <T,>(what: string, run: () => Promise<T>): Promise<T | null> => {
  try {
    return await run();
  } catch (e) {
    log.warn(`[dashboard] ${what} read failed:`, e instanceof Error ? e.message : String(e));
    return null;
  }
};

/**
 * The dashboard at `/`: one server instant for every date; the digest and the counts through the one cached read (per workspace, a failure never kept); the watchlist and the reader's name fresh. Every
 * read reports its own failure to the body, which says so with Retry; a count the page could not read is blank, never zero.
 */
export default async function DashboardRoute() {
  const session = await pageSession("/");
  if ("failed" in session) return <PageFailure what="Your brief" />;
  const now = new Date(session.nowIso);
  const dateLabel = formatLocaleDate(now, { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const orgId = session.orgId;
  if (!orgId) {
    return (
      <>
        <div className="cl-list-surface-masthead">
          <DashboardMasthead firstName={firstTokenOf(session.email)} orgName="" sectors={[]} itemCount={null} jurisdictionCount={null} noWorkspace dateLabel={dateLabel} nowIso={session.nowIso} />
        </div>
        <PageFrame>
          <StateNote action={{ label: "Set up a workspace →", href: "/workspace/new" }}>Your brief shows what is new and due for a workspace. Join or create one to see it.</StateNote>
        </PageFrame>
      </>
    );
  }
  const db = await userClient();
  const [{ profile, failed: profileFailed }, digest, counts, watch, name, themes, coverage] = await Promise.all([
    readWorkspaceProfile(db, orgId),
    cachedRead(["dashboard-digest", orgId], () => readDigest(db, orgId), { tags: [APP_DATA_TAG], revalidate: REVALIDATE_SECONDS }),
    cachedRead(["dashboard-counts", orgId], () => readCounts(db, orgId), { tags: [APP_DATA_TAG], revalidate: REVALIDATE_SECONDS }),
    settle("watchlist", () => readWatchlist(db, { userId: session.userId, orgId }, WATCHLIST_RAIL_LIMIT, now)),
    settle("profile", async () => {
      const { data, error } = await db.from("profiles").select("full_name, display_name").eq("id", session.userId).maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { full_name: string | null; display_name: string | null } | null)?.full_name ?? (data as { display_name: string | null } | null)?.display_name ?? null;
    }),
    settle("themes", () => readThemeChips(db, { surface: null, minPages: 2, max: 3 })),
    settle("source coverage", () => readSourceCoverage(db)),
  ]);

  const d = digest.ok ? digest.value : null;
  const dueRows = d ? buildDueNextRows(d.dueNext, now) : [];
  const changedRows = d ? buildChangedRows(d.feed, d.candidates, d.changelogField, now, { jurisdictionWeights: profile.jurisdictions, sectors: profile.verticals }) : [];
  const totals = counts.ok ? counts.value : null;
  return (
    <>
      <div className="cl-list-surface-masthead">
        <DashboardMasthead firstName={firstTokenOf(name ?? session.email)} orgName={session.orgName} sectors={profile.verticals} itemCount={totals ? surfaceItemTotal(totals.surfaces) : null} jurisdictionCount={totals?.aggregates.totalJurisdictions ?? null} dateLabel={dateLabel} nowIso={session.nowIso} />
      </div>
      <DashboardBrief
        dueRows={dueRows}
        dueWindow={dueNextWindowLabel(dueRows, formatLocaleDate(now, { month: "short", day: "numeric", timeZone: "UTC" }))}
        changedRows={changedRows}
        totalChanges={d ? new Set(d.feed.map((f) => f.id)).size : 0}
        windowDays={d?.windowDays ?? 0}
        auditDate={d ? computeAuditDate(d.feed.map((f) => ({ changeDate: f.change_date ?? f.added_date })), d.lastChangelogDate) : ""}
        rowsFailed={!digest.ok}
        ratingsFailed={d?.ratingsFailed ?? false}
        degraded={[
          ...(profileFailed ? ["Your workspace profile did not load, so this brief is ranked without your sectors and jurisdictions."] : []),
          ...(d?.timelinesFailed || watch?.timelinesFailed ? ["Milestone dates did not load for some rows, so their timelines are blank."] : []),
          ...(d?.holdUnknown ? [`The collection hold state did not load, so the change window shown is the last ${d.windowDays} days.`] : []),
        ]}
        counts={totals}
        watchlist={watch?.items ?? null}
        themes={themes}
        coverage={coverage}
      />
    </>
  );
}
