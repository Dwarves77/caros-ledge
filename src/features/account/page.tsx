// Ported from old_repo/src/app/profile/page.tsx (lines 16-25)
import { PageFailure } from "@/ui/shell/PageFailure";

import { resolveInitialProfileTab } from "./lib/initial-tab";
import { pageSession } from "./server/page-session";
import { AccountPage } from "./ui/AccountPage";

/** The /profile server gate: no session goes to /login and back, a failed identity lookup is a failure page with Retry. The tab comes from `?tab=`. */
export default async function AccountRoute({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const session = await pageSession("/profile");
  if ("failed" in session) return <PageFailure what="Your account" />;
  const tab = (await searchParams).tab;
  return <AccountPage userId={session.userId} userEmail={session.email} orgId={session.orgId} orgName={session.orgName} role={session.role} nowIso={session.nowIso} initialTab={resolveInitialProfileTab(Array.isArray(tab) ? tab[0] : tab)} />;
}
