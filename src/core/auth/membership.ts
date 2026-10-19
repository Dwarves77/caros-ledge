// Ported from old_repo/src/lib/api/org.ts (lines 21-119)
// Ported from old_repo/src/app/api/orgs/[org_id]/members/route.ts (lines 12-48)
import type { Db } from "@/core/db/clients";
import { LookupError } from "@/core/http/errors";
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
