// Ported from old_repo/src/app/api/admin/users/route.ts (lines 79-101)
import { boundedRead } from "@/core/db";
import { LookupError } from "@/core/http/errors";

import { adminRoute, reply } from "./shared";

export const USERS_BOUND = 200;

/** Members of every organisation with the profile embed, newest first. Profiles and e-mails are read only on the service client behind the admin gate (SEC-5). Bounded: a capped list says so. */
export const GET = adminRoute("/api/admin/users", async (admin) => {
  const service = admin.service();
  const r = await boundedRead<Record<string, unknown>>((n) => service.from("org_memberships").select("id, org_id, user_id, role, created_at, user:profiles!user_id(full_name, display_name, email, avatar_url)").order("created_at", { ascending: false }).order("id", { ascending: true }).limit(n), { limit: USERS_BOUND });
  if (r.error) throw new LookupError("org_memberships", r.error);
  return reply(admin, { members: r.data, capped: r.truncated });
});
