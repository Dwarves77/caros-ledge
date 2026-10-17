// Ported from old_repo/src/app/watchlist/page.tsx (lines 29-46)
import { userClient } from "@/core/db/clients";
import { formatLocaleDate } from "@/core/shared";
import { log } from "@/core/shared/log";
import { pageSession } from "@/features/account/server/page-session";
import { PageFailure } from "@/ui/shell/PageFailure";

import { NOTICE_WINDOW_DAYS, readNotices, type NoticesRead } from "./read/notices";
import { readWatchlist, WATCHLIST_PAGE_LIMIT, type WatchlistRead } from "./read/watchlist";
import { WatchlistSurface } from "./ui/WatchlistSurface";

const settle = async <T,>(what: string, run: () => Promise<T>): Promise<T | null> => {
  try {
    return await run();
  } catch (e) {
    log.warn(`[watchlist] ${what} read failed:`, e instanceof Error ? e.message : String(e));
    return null;
  }
};

/** /watchlist: the session gate, then the two reads on the caller's own client. Each reports its own failure to the surface, which says so with Retry (INV-263); the clock is the request's one instant. */
export default async function WatchlistRoute() {
  const session = await pageSession("/watchlist");
  if ("failed" in session) return <PageFailure what="Your watchlist" />;
  const db = await userClient();
  const now = new Date(session.nowIso);
  const noWorkspace: NoticesRead = { notices: [], since: new Date(now.getTime() - NOTICE_WINDOW_DAYS * 86_400_000).toISOString() };
  const [watch, notices]: [WatchlistRead | null, NoticesRead | null] = await Promise.all([
    settle("watchlist", () => readWatchlist(db, { userId: session.userId, orgId: session.orgId }, WATCHLIST_PAGE_LIMIT, now)),
    session.orgId ? settle("notices", () => readNotices(db, session.orgId as string, now)) : Promise.resolve(noWorkspace),
  ]);
  const dateLabel = formatLocaleDate(now, { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  return <WatchlistSurface watch={watch} notices={notices} limit={WATCHLIST_PAGE_LIMIT} dateLabel={dateLabel} nowIso={session.nowIso} />;
}
