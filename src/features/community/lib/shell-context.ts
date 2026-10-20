// Ported from old_repo/src/lib/community/shell-context.ts (lines 16-172)
// What every Community page needs about the signed-in member: their memberships and pending invitations (a failed read throws, so a page says so with Retry instead of drawing "no groups"), the per-region group counts,
// and the footer identity. The member's own profile comes through my_profile() (SEC-5: email is not a column a client reads); the platform-admin bit comes from is_platform_admin() only, and is a display gate, so a
// failed read of it is "not an admin". The employer is the session's organisation (the oldest membership, resolved once). Topics are not read: no writer exists (the ruling drops them).
import { LookupError } from "@/core/http/errors";
import { readOwnPlatformAdmin } from "@/core/auth/platform-admin";
import type { Db } from "@/core/db/clients";
import { log } from "@/core/shared/log";

import { REGION_CODES } from "./labels";
import type { CurrentUser, GroupSummary, Membership, PendingInvitation } from "./types";

export interface Me {
  name: string;
  avatarUrl: string | null;
  verifierStatus: string;
  workspaceRole: string | null;
  homes: string[];
  orgId: string | null;
}
export interface ShellContext {
  currentUser: CurrentUser;
  memberships: Membership[];
  invitations: PendingInvitation[];
  regionCounts: Record<string, number>;
}

const GROUP_COLUMNS = "id, name, slug, region, privacy, member_count, weekly_post_count, last_active_at";
const LIMIT = 500;

/** The caller's own profile row through my_profile(); a failed read throws. */
export async function loadMe(db: Db, fallbackName: string): Promise<Me> {
  const { data, error } = await db.rpc("my_profile");
  if (error) throw new LookupError("my_profile", error);
  const row = ((Array.isArray(data) ? data[0] : data) ?? null) as { full_name?: string | null; display_name?: string | null; avatar_url?: string | null; verifier_status?: string | null; workspace_role?: string | null; jurisdiction_overrides?: string[] | null; org_id?: string | null } | null;
  return {
    name: row?.full_name?.trim() || row?.display_name?.trim() || fallbackName,
    avatarUrl: row?.avatar_url ?? null,
    verifierStatus: row?.verifier_status ?? "none",
    workspaceRole: row?.workspace_role ?? null,
    homes: row?.jurisdiction_overrides ?? [],
    orgId: row?.org_id ?? null,
  };
}

export async function loadMemberships(db: Db, userId: string): Promise<Membership[]> {
  const { data, error } = await db.from("community_group_members").select(`group_id, role, starred, muted, joined_at, community_groups(${GROUP_COLUMNS})`).eq("user_id", userId).order("joined_at", { ascending: true }).order("group_id", { ascending: true }).limit(LIMIT);
  if (error) throw new LookupError("group memberships", error);
  return ((data ?? []) as unknown as Array<Omit<Membership, "group"> & { community_groups: GroupSummary | null }>).flatMap((m) => (m.community_groups ? [{ group_id: m.group_id, role: m.role, starred: !!m.starred, muted: !!m.muted, joined_at: m.joined_at, group: { ...m.community_groups, member_count: m.community_groups.member_count ?? 0, weekly_post_count: m.community_groups.weekly_post_count ?? 0 } }] : []));
}

export async function loadInvitations(db: Db, userId: string): Promise<PendingInvitation[]> {
  const { data, error } = await db.from("community_group_invitations").select("id, group_id, inviter_user_id, created_at, community_groups(id, name, slug, region, privacy)").eq("invitee_user_id", userId).eq("status", "pending").order("created_at", { ascending: false }).order("id", { ascending: true }).limit(LIMIT);
  if (error) throw new LookupError("pending invitations", error);
  return ((data ?? []) as unknown as Array<Omit<PendingInvitation, "group"> & { community_groups: PendingInvitation["group"] | null }>).flatMap((i) => (i.community_groups ? [{ id: i.id, group_id: i.group_id, inviter_user_id: i.inviter_user_id, created_at: i.created_at, group: i.community_groups }] : []));
}

async function loadRegionCounts(db: Db, args?: { p_privacy: string }): Promise<Record<string, number>> {
  const { data, error } = await (args ? db.rpc("community_region_counts", args) : db.rpc("community_region_counts"));
  if (error) throw new LookupError("region counts", error);
  const counts: Record<string, number> = Object.fromEntries(REGION_CODES.map((c) => [c, 0]));
  for (const r of (data ?? []) as Array<{ region: string; count: number | string }>) counts[r.region] = Number(r.count) || 0;
  return counts;
}

export async function loadShellContext(db: Db, session: { userId: string; email: string; orgName: string }, opts: { regionCountsArgs?: { p_privacy: string } } = {}): Promise<ShellContext> {
  const fallback = session.email.split("@")[0] ?? "";
  const [memberships, invitations, regionCounts, me, isAdmin] = await Promise.all([
    loadMemberships(db, session.userId),
    loadInvitations(db, session.userId),
    loadRegionCounts(db, opts.regionCountsArgs),
    loadMe(db, fallback).catch((e: unknown) => {
      log.warn("[community] the footer identity could not be read; showing the account name:", e instanceof Error ? e.message : String(e));
      return { name: fallback, avatarUrl: null } as Pick<Me, "name" | "avatarUrl">;
    }),
    readOwnPlatformAdmin(db).catch((e: unknown) => {
      log.warn("[community] the admin bit could not be read; treating the member as not an admin:", e instanceof Error ? e.message : String(e));
      return false;
    }),
  ]);
  return { currentUser: { id: session.userId, email: session.email, name: me.name, headshotUrl: me.avatarUrl, employer: session.orgName, isPlatformAdmin: isAdmin }, memberships, invitations, regionCounts };
}
