// Ported from old_repo/src/app/community/browse/page.tsx (lines 59-239)
// /community/browse: the public groups of a region (private groups are by invitation only and appear in your sidebar once you are in them), each with your membership state. A groups read that fails is a stated failure with
// Retry (it used to draw "No public groups"); your memberships and pending invitations are two bulk reads joined in memory, not one per card.
import { many } from "../api/_http";
import { REGION_CODES, regionLabel } from "../lib/labels";
import type { GroupSummary } from "../lib/types";
import type { BrowseRow } from "../ui/groups/GroupGrid";

import { communityPage } from "./frame";
import { BrowseScreen } from "./screens";

export async function BrowsePage({ region: requested }: { region?: string | undefined }) {
  const region = REGION_CODES.includes((requested ?? "").toUpperCase()) ? (requested ?? "").toUpperCase() : "EU";
  return communityPage(
    "/community/browse",
    "The group directory",
    async ({ db, session, nowIso }) => {
      const groups = await many<GroupSummary>(
        db.from("community_groups").select("id, name, slug, region, privacy, description, member_count, weekly_post_count, last_active_at").eq("privacy", "public").eq("region", region).order("member_count", { ascending: false }).order("id", { ascending: true }).limit(200),
        "public groups",
      );
      const ids = groups.map((g) => g.id);
      const [mine, invited] = ids.length
        ? await Promise.all([
            many<{ group_id: string }>(db.from("community_group_members").select("group_id").eq("user_id", session.userId).in("group_id", ids), "your memberships"),
            many<{ group_id: string }>(db.from("community_group_invitations").select("group_id").eq("invitee_user_id", session.userId).eq("status", "pending").in("group_id", ids), "your invitations"),
          ])
        : [[], []];
      const member = new Set(mine.map((m) => m.group_id));
      const pending = new Set(invited.map((m) => m.group_id));
      const rows: BrowseRow[] = groups.map((g) => ({ group: g, state: member.has(g.id) ? "member" : pending.has(g.id) ? "pending-invite" : "none" }));
      return <BrowseScreen regionLabel={regionLabel(region)} rows={rows} nowIso={nowIso} />;
    },
    { region, regionCountsArgs: { p_privacy: "public" } },
  );
}
