// Ported from old_repo/src/lib/api/org.ts (lines 21-119)
// Ported from old_repo/src/app/api/orgs/[org_id]/members/route.ts (lines 12-48)
// Ported from old_repo/src/app/api/orgs/[org_id]/members/route.ts (lines 204-227)
// Ported from old_repo/src/lib/orgs/ban-check.mjs (lines 1-17)
import type { Db } from "@/core/db/clients";
import { HttpError, LookupError } from "@/core/http/errors";
import type { OrgMembership, OrgRole } from "@/core/types";

export { LookupError };
export const ROLE_RANK: Record<OrgRole, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

/**
 * The caller's membership: in `orgId` when given, else the OLDEST membership (the active organisation).
 * Null when there is none; a failed read throws LookupError.
 */
export async function currentMembership(client: Db, userId: string, orgId?: string | null): Promise<OrgMembership | null> {
  let query = client.from("org_memberships").select("org_id, role").eq("user_id", userId);
  if (orgId) query = query.eq("org_id", orgId);
  const { data, error } = await query.order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (error) throw new LookupError("org_memberships", error);
  return data?.org_id ? { orgId: data.org_id as string, role: data.role as OrgRole } : null;
}

/** An organisation keeps at least one owner (INV-153): demoting, banning or removing the only owner is a 409. */
export async function assertNotLastOwner(service: Db, orgId: string, action: string): Promise<void> {
  const { count, error } = await service.from("org_memberships").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("role", "owner");
  if (error || count == null) throw new LookupError("owner count", error ?? "no count returned");
  if (count <= 1) throw new HttpError(409, `Cannot ${action} the only owner. Promote another member to owner first.`);
}

/** Org-scoped ban lookup (operator ruling 2026-07-07): not a platform ban. Fails closed. */
export async function isBanned(service: Db, orgId: string, userId: string): Promise<boolean> {
  const { data, error } = await service.from("org_member_bans").select("user_id").eq("org_id", orgId).eq("user_id", userId).maybeSingle();
  if (error) throw new LookupError("org_member_bans", error);
  return !!data;
}
