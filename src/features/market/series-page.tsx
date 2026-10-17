// Ported from old_repo/src/app/market/series/page.tsx (lines 1-23)
// /market/series: every producer the product carries, and every observed series with its value, freshness, source rating and methodology. The lineage check needs the service client; without it the "change on record" row is absent.
import { isServiceConfigured, serviceClient, userClient } from "@/core/db";
import { formatLocaleDate } from "@/core/shared";
import { pageSession } from "@/features/account/server/page-session";
import { PageFailure } from "@/ui/shell/PageFailure";
import { Masthead } from "@/ui";
import { ShellCommandBar } from "@/ui/shell";

import { readMarketSeries, section } from "./read";
import { RetryNote } from "./ui/RetryNote";
import { SeriesBoard } from "./ui/SeriesBoard";
import styles from "./ui/market.module.css";

export default async function MarketSeriesPage() {
  const session = await pageSession("/market/series");
  if ("failed" in session) return <PageFailure what="The series board" />;
  const db = await userClient();
  const series = await section("series board", () => readMarketSeries(db, { edgeDb: isServiceConfigured() ? serviceClient() : null }));
  return (
    <>
      <div className="cl-list-surface-masthead">
        <Masthead
          title="Market / Series board"
          dek="Every source the product carries, with dated numeric observations grouped by source, not signal cards."
          dateLabel={formatLocaleDate(new Date(session.nowIso), { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}
          nowIso={session.nowIso}
          commandBar={<ShellCommandBar />}
        />
      </div>
      <div className={`${styles.band} ${styles.bandTop}`}>{series.ok ? <SeriesBoard board={series.data.board} ratings={series.data.ratings} nowIso={session.nowIso} lineage={series.data.lineage} /> : <RetryNote what="The series board" />}</div>
    </>
  );
}
