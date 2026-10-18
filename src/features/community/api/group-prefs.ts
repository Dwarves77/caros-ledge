// Ported from old_repo/src/lib/community/member-pref-route.mjs (lines 1-60)
// Ported from old_repo/src/lib/community/group-member-prefs.mjs (lines 1-17)
// Ported from old_repo/src/app/api/community/groups/[id]/star/route.ts (lines 1-3)
// PATCH star and PATCH mute on the caller's own membership row: one handler for both fields. A mute is honoured by the one notification path (allowedRecipients), not stored and ignored.
import { dbError, HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";

import { idParam } from "./_http";

function toggle(field: "starred" | "muted") {
  return route(`/api/community/groups/[id]/${field === "starred" ? "star" : "mute"}`, async (request, ctx: { params: Promise<{ id: string }> }) => {
    const auth = await requireUser(request);
    if (isRefusal(auth)) return auth;
    const groupId = await idParam(ctx, "id", "group id");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
    const value = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)[field] : undefined;
    if (typeof value !== "boolean") throw new HttpError(400, `${field} (boolean) is required`);
    const { data, error } = await auth.client.from("community_group_members").update({ [field]: value }).eq("group_id", groupId).eq("user_id", auth.userId).select("group_id").maybeSingle();
    if (error) throw dbError(error, { forbidden: "You can't change this setting" });
    if (!data) throw new HttpError(404, "You are not a member of this group");
    return ok(auth.headers, { ok: true, [field]: value });
  });
}
export const PATCH_STAR = toggle("starred");
export const PATCH_MUTE = toggle("muted");
