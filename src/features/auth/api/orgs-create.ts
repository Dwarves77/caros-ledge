// Ported from old_repo/src/app/api/orgs/route.ts (lines 8-62)
import { createOrgBody, createOrgForSelf } from "@/core/auth/orgs";
import { ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";
import { ALL_SECTORS, ORG_SIZE_DIMENSIONS, REGIONS } from "@/core/workspace";

/** The vocabularies the workspace slice owns, passed to the body schema: an id outside them is a 400. */
const VOCAB = {
  sectors: new Set(ALL_SECTORS.map((s) => s.id)),
  regions: new Set(REGIONS.map((r) => r.id)),
  headcountBands: new Set((ORG_SIZE_DIMENSIONS.headcount?.bands ?? []).map((b) => b.id)),
};

/** POST /api/orgs: create an organisation for the caller, who becomes its owner. */
export const POST = route("/api/orgs", async (request) => {
  const user = await requireUser(request);
  if (isRefusal(user)) return user;
  const input = await parseJson(request, createOrgBody(VOCAB));
  const created = await createOrgForSelf(user.client, { id: user.userId, email: user.email }, input);
  return ok(user.headers, { org_id: created.orgId, slug: created.slug, name: created.name, settings_saved: created.settingsSaved, profile_saved: created.profileSaved }, 201);
});
