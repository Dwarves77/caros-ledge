// Ported from old_repo/src/app/settings/page.tsx (lines 14-40)
import { PageFailure } from "@/ui/shell/PageFailure";
import { pageSession } from "@/features/account/server/page-session";
import { userClient } from "@/core/db/clients";

import { readSettingsData } from "./server/settings-data";
import { SettingsPage } from "./ui/SettingsPage";

/** The /settings server gate: the session, then the page's three bounded reads (archive, supersessions); each section reports its own failed read. */
export default async function SettingsRoute() {
  const session = await pageSession("/settings");
  if ("failed" in session) return <PageFailure what="Settings" />;
  const data = await readSettingsData(await userClient(), { orgId: session.orgId, userId: session.userId });
  return <SettingsPage userId={session.userId} nowIso={session.nowIso} orgName={session.orgName} data={data} />;
}
