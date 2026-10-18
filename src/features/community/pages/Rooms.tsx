// Ported from old_repo/src/app/community/page.tsx (lines 134-508)
// /community: the seven regional rooms. The session and the request's one instant, then ONE reader (readRoomsHome) over the caller's own client, then the screen (screens.tsx): the masthead, the invitations and your
// groups (CommunityHome: the old page never mounted them, so an invitation could not be answered), and the rooms index. A read the page cannot be drawn without is the stated failure with Retry; a block that fails says
// so inside the page and the rest draws.
import { unstable_rethrow } from "next/navigation";

import { log } from "@/core/shared/log";
import { PageFailure } from "@/ui/shell";

import { readRoomsHome } from "../lib/rooms-read";

import { openPage } from "./frame";
import { RoomsScreen } from "./screens";

export async function RoomsPage() {
  const page = await openPage("/community");
  if ("failed" in page) return <PageFailure what="Community" />;
  let home;
  try {
    home = await readRoomsHome(page.db, { userId: page.session.userId, email: page.session.email, orgId: page.session.orgId });
  } catch (e) {
    unstable_rethrow(e);
    log.warn("[community] the rooms home did not load:", e instanceof Error ? e.message : String(e));
    return <PageFailure what="Community" />;
  }
  return <RoomsScreen home={home} dateLabel={page.dateLabel} nowIso={page.nowIso} />;
}
