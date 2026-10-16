// Ported from old_repo/src/app/api/workspace/tags/[id]/items/route.ts (lines 24-124)
import { z } from "zod";

import { serviceClient } from "@/core/db/clients";
import { dbError, HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireOrgRole } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";

import { itemUuidOr404 } from "./shared";

type Ctx = { params: Promise<{ id: string }> };
const body = z.object({ itemId: z.string().min(1) });

// PUT applies a tag to one item, DELETE removes it. ATTRIBUTION (migration 313, INV-166): created_by is stamped from the SESSION and never
// read from the body, and a second apply keeps the FIRST applier and date (ON CONFLICT DO NOTHING); a plain upsert rewrote created_by to
// the re-applier while created_at stayed, pairing one member's name with another's date. The tag must belong to the caller's org.
export const PUT = route<Ctx>("/api/workspace/tags/[id]/items", async (request, { params }) => {
  const auth = await requireOrgRole(request, "member");
  if (isRefusal(auth)) return auth;
  const { orgId } = auth.membership;
  const tagId = (await params).id;
  const service = serviceClient();
  const { data: tag, error } = await service.from("workspace_tags").select("id").eq("id", tagId).eq("org_id", orgId).maybeSingle();
  if (error) throw new LookupError("workspace_tags", error);
  if (!tag) throw new HttpError(404, "Tag not found in your workspace");
  const input = await parseJson(request, body);
  const itemUuid = await itemUuidOr404(service, input.itemId);
  const { error: writeError } = await service
    .from("item_workspace_tags")
    .upsert({ tag_id: tagId, intelligence_item_id: itemUuid, org_id: orgId, created_by: auth.userId }, { onConflict: "tag_id,intelligence_item_id", ignoreDuplicates: true });
  if (writeError) throw dbError(writeError);
  return ok(auth.headers, { success: true });
});

export const DELETE = route<Ctx>("/api/workspace/tags/[id]/items", async (request, { params }) => {
  const auth = await requireOrgRole(request, "member");
  if (isRefusal(auth)) return auth;
  const tagId = (await params).id;
  const input = await parseJson(request, body);
  const service = serviceClient();
  const itemUuid = await itemUuidOr404(service, input.itemId);
  const { error } = await service.from("item_workspace_tags").delete().eq("tag_id", tagId).eq("intelligence_item_id", itemUuid).eq("org_id", auth.membership.orgId);
  if (error) throw dbError(error);
  return ok(auth.headers, { success: true });
});
