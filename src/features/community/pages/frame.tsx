// Ported from old_repo/src/app/community/[slug]/page.tsx (lines 28-129)
// Ported from old_repo/src/app/community/browse/page.tsx (lines 49-185)
// The one frame every Community page shares (seven pages each carried their own sign-in check, `auth.getUser()` network round trip, shell-context load and timing logs): the session gate (claims checked locally, a sign-out goes to
// /login and back), the request's one instant, the shell context, and a read that fails drawn as a stated failure with Retry. A sub-page body is a function from this context to elements; notFound and redirect pass through.
import { unstable_rethrow } from "next/navigation";
import type { ReactNode } from "react";

import { userClient, type Db } from "@/core/db/clients";
import { formatLocaleDate } from "@/core/shared";
import { log } from "@/core/shared/log";
import { pageSession, type PageSession } from "@/features/account/server/page-session";
import { PageFailure } from "@/ui/shell";

import { loadShellContext, type ShellContext } from "../lib/shell-context";
import { CommunityLayout } from "../ui/Layout";

export interface PageContext {
  db: Db;
  session: PageSession;
  nowIso: string;
  dateLabel: string;
}

const dateLabelOf = (nowIso: string): string => formatLocaleDate(new Date(nowIso), { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

/** The gate and the context, or `{ failed }` when the identity lookup failed (the page then says so with Retry). */
export async function openPage(path: string): Promise<{ failed: true } | PageContext> {
  const session = await pageSession(path);
  if ("failed" in session) return { failed: true };
  return { db: await userClient(), session, nowIso: session.nowIso, dateLabel: dateLabelOf(session.nowIso) };
}

/** A /community sub-page: the layout with its sidebar, around a body that reads what it needs. A failed read anywhere is the stated failure. */
export async function communityPage(path: string, what: string, body: (ctx: PageContext & { shell: ShellContext }) => Promise<ReactNode>, opts: { region?: string; regionCountsArgs?: { p_privacy: string } } = {}): Promise<ReactNode> {
  const page = await openPage(path);
  if ("failed" in page) return <PageFailure what={what} />;
  try {
    const shell = await loadShellContext(page.db, { userId: page.session.userId, email: page.session.email, orgName: page.session.orgName }, opts.regionCountsArgs ? { regionCountsArgs: opts.regionCountsArgs } : {});
    const content = await body({ ...page, shell });
    return (
      <CommunityLayout shell={shell} nowIso={page.nowIso} dateLabel={page.dateLabel} {...(opts.region !== undefined ? { region: opts.region } : {})}>
        {content}
      </CommunityLayout>
    );
  } catch (e) {
    unstable_rethrow(e); // notFound and redirect are Next's, not a failed read
    log.warn(`[community] ${path} did not load:`, e instanceof Error ? e.message : String(e));
    return <PageFailure what={what} />;
  }
}
