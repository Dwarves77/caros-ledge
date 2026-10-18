// Ported from old_repo/src/app/api/community/groups/[id]/members/route.ts (lines 15-90)
// Ported from old_repo/src/components/community/CouncilMembersRail.tsx (lines 22-60)
// A group's roster as one read the members route and the group page's rail share: the rows the caller's row policy shows (themselves; everyone for an admin or moderator), each with the name the identity definer allows.
// No user id leaves it. A failed read throws (the rail used to draw its private-group message for a read error); a failed identity read shows members without names, and says so.
import { LookupError } from "@/core/http/errors";
import type { Db } from "@/core/db/clients";


import { loadIdentities } from "./identity";

export interface RosterEntry {
  role: string;
  joined_at: string;
  /** The end of a moderator's mute while it runs; null when not muted or expired. */
  muted_until: string | null;
  name: string | null;
  headshot_url: string | null;
  anonymous: boolean;
  is_self: boolean;
}
const ROLE_ORDER: Record<string, number> = { admin: 0, moderator: 1, member: 2 };

export async function readRoster(db: Db, groupId: string, userId: string, limit: number): Promise<{ members: RosterEntry[]; truncated: boolean; identityFailed: boolean }> {
  const { data, error } = await db.from("community_group_members").select("user_id, role, joined_at, muted_until").eq("group_id", groupId).order("joined_at", { ascending: true }).order("user_id", { ascending: true }).limit(limit);
  if (error) throw new LookupError("members", error);
  const rows = (data ?? []) as Array<{ user_id: string; role: string; joined_at: string; muted_until: string | null }>;
  const { byId, error: identityError } = await loadIdentities(db, rows.map((m) => m.user_id));
  const members = rows
    .map((m) => {
      const identity = byId.get(m.user_id) ?? null;
      const hidden = !identity || identity.anonymous;
      return { role: m.role, joined_at: m.joined_at, muted_until: m.muted_until && Date.parse(m.muted_until) > Date.now() ? m.muted_until : null, name: hidden ? null : identity.display_name, headshot_url: hidden ? null : identity.avatar_url, anonymous: hidden, is_self: m.user_id === userId };
    })
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || (a.name ?? "").localeCompare(b.name ?? ""));
  return { members, truncated: rows.length >= limit, identityFailed: identityError !== null };
}
