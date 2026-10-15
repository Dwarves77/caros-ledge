// Ported from old_repo/src/app/api/orgs/route.ts (lines 8-62)
import { createOrgBody, createOrgForSelf } from "@/core/auth/orgs";
import { ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";

/** POST /api/orgs: create an organisation for the caller, who becomes its owner. */
export const POST = route("/api/orgs", async (request) => {
  const user = await requireUser(request);
  if (isRefusal(user)) return user;
  const input = await parseJson(request, createOrgBody());
  const created = await createOrgForSelf(user.client, { id: user.userId, email: user.email }, input);
  return ok(user.headers, { org_id: created.orgId, slug: created.slug, name: created.name, settings_saved: created.settingsSaved, profile_saved: created.profileSaved }, 201);
});
