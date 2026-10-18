// Ported from old_repo/src/app/community/[slug]/page.tsx (lines 38-273)
// /community/[slug]: one group. The group is read under row security, so a private group the caller is not in reads as "no row" and answers exactly as a slug that does not exist (a 404 that leaks nothing); a READ ERROR is
// a stated failure, never a 404. The header (star, mute, members, invite, settings), the description, the feed with its composer, and the members rail (screens.tsx). The removed "how publishing works" card described
// a promotion path ADR-041 removed.
import { notFound } from "next/navigation";

import { LookupError } from "@/core/http/errors";

import { one } from "../api/_http";
import { readRoster } from "../lib/roster";
import type { GroupRole, GroupSummary } from "../lib/types";

import { communityPage } from "./frame";
import { GroupScreen } from "./screens";

export async function GroupPage({ slug }: { slug: string }) {
  return communityPage(`/community/${slug}`, "This group", async ({ db, session, nowIso }) => {
    const group = await one<GroupSummary & { description: string | null }>(
      db.from("community_groups").select("id, name, slug, region, privacy, description, member_count, weekly_post_count, last_active_at").eq("slug", slug).maybeSingle(),
      "group",
    );
    if (!group) notFound();
    const [membership, own, rail] = await Promise.all([
      one<{ role: GroupRole; starred: boolean; muted: boolean }>(db.from("community_group_members").select("role, starred, muted").eq("group_id", group.id).eq("user_id", session.userId).maybeSingle(), "membership"),
      one<{ default_anonymous: boolean }>(db.from("community_member_profiles").select("default_anonymous").eq("user_id", session.userId).maybeSingle(), "member profile"),
      readRoster(db, group.id, session.userId, 200).catch((e: unknown) => (e instanceof LookupError ? null : Promise.reject(e))),
    ]);
    return <GroupScreen group={group} membership={membership} defaultAnonymous={own?.default_anonymous ?? false} rail={rail} meId={session.userId} nowIso={nowIso} />;
  });
}
