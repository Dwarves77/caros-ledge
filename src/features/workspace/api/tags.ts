// Ported from old_repo/src/app/api/workspace/tags/route.ts (lines 30-236)
// Ported from old_repo/src/lib/tags/server.ts (lines 39-130)
import { z } from "zod";

import { serviceClient } from "@/core/db/clients";
import { fetchAllRows } from "@/core/db/query";
import { dbError, HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireOrgRole } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";
import { log } from "@/core/shared/log";
import { resolveItemUuid } from "@/core/shared/ids";

import { buildApplications, groupApplicationsByItem, loadAuthorNames, normalizeTagName, type ItemTagLinkRow, type TagApplication } from "./tag-attribution";

// GET lists the caller's workspace tags with live item counts (the + Tag popover and the list rail facet). Reads are bounded and total-ordered:
// at most 500 tags (counts from the workspace_tag_counts view) and 5000 applications per workspace read, and a workspace past either is an error, never a silently short list.
// ?itemId= adds `appliedTagIds` and `applications` (who applied each tag and when) for one item; ?withItemTags=1 adds the item to tags map.
// POST creates a tag (a duplicate name returns the EXISTING tag); DELETE removes one and CASCADE removes its applications (migration 313).
export interface WorkspaceTag {
  id: string;
  orgId: string;
  name: string;
  itemCount: number;
  createdAt: string;
}
type TagRow = { id: string; org_id: string; name: string; created_at: string };

const toTag = (row: TagRow, itemCount: number): WorkspaceTag => ({ id: row.id, orgId: row.org_id, name: row.name, itemCount, createdAt: row.created_at });
const createBody = z.object({ name: z.unknown() });
const deleteBody = z.object({ tagId: z.string().min(1) });

export const GET = route("/api/workspace/tags", async (request) => {
  const auth = await requireOrgRole(request, "viewer");
  if (isRefusal(auth)) return auth;
  const { orgId } = auth.membership;
  const service = serviceClient();
  const params = new URL(request.url).searchParams;
  const rawItemId = params.get("itemId");
  const withItemTags = !!params.get("withItemTags");
  let itemUuid: string | null = null;
  if (rawItemId) {
    try {
      itemUuid = await resolveItemUuid(service, rawItemId);
    } catch (e) {
      throw new LookupError("intelligence_items", e);
    }
  }
  let tagRows: TagRow[];
  let countRows: { tag_id: string; item_count: number }[];
  let links: ItemTagLinkRow[] = [];
  try {
    tagRows = await fetchAllRows((from, to) => service.from("workspace_tags").select("id, org_id, name, created_at").eq("org_id", orgId).order("name", { ascending: true }).order("id", { ascending: true }).range(from, to), { cap: 500 });
    // Counts come from the database (view workspace_tag_counts, migration 0024); the join rows are read only when the response needs who applied what.
    countRows = await fetchAllRows((from, to) => service.from("workspace_tag_counts").select("tag_id, item_count").eq("org_id", orgId).order("tag_id", { ascending: true }).range(from, to), { cap: 500 });
    if (withItemTags || itemUuid) {
      links = await fetchAllRows(
        (from, to) => {
          const q = service.from("item_workspace_tags").select("tag_id, intelligence_item_id, created_by, created_at").eq("org_id", orgId);
          return (withItemTags ? q : q.eq("intelligence_item_id", itemUuid as string)).order("tag_id", { ascending: true }).order("intelligence_item_id", { ascending: true }).range(from, to);
        },
        { cap: 5000 },
      );
    }
  } catch (e) {
    throw new LookupError("workspace tags", e);
  }
  const counts = new Map(countRows.map((r) => [r.tag_id, r.item_count]));
  const itemLinks = itemUuid ? links.filter((l) => l.intelligence_item_id === itemUuid) : [];
  // Names for the applying members; a failed read leaves names out and says so, it does not fail the tag list.
  let names = new Map<string, string | null>();
  let namesUnavailable = false;
  if (itemLinks.length > 0 || withItemTags) {
    try {
      names = await loadAuthorNames(service, (withItemTags ? links : itemLinks).map((l) => l.created_by).filter((id): id is string => !!id));
    } catch (e) {
      namesUnavailable = true;
      log.warn("[tags] author names unavailable, chips render without them:", e instanceof Error ? e.message : String(e));
    }
  }

  const itemTags: Record<string, string[]> = {};
  if (withItemTags) for (const l of links) (itemTags[l.intelligence_item_id] ??= []).push(l.tag_id);
  const applications: TagApplication[] = buildApplications(itemLinks, names);
  return ok(auth.headers, {
    tags: tagRows.map((row) => toTag(row, counts.get(row.id) ?? 0)),
    ...(itemUuid ? { appliedTagIds: itemLinks.map((l) => l.tag_id), applications } : {}),
    ...(withItemTags ? { itemTags, itemTagApplications: groupApplicationsByItem(links, names) } : {}),
    ...(namesUnavailable ? { namesUnavailable: true } : {}),
  });
});

export const POST = route("/api/workspace/tags", async (request) => {
  const auth = await requireOrgRole(request, "member");
  if (isRefusal(auth)) return auth;
  const { orgId } = auth.membership;
  const name = normalizeTagName((await parseJson(request, createBody)).name);
  if (!name) throw new HttpError(400, "name is required (1-60 characters)");
  const service = serviceClient();
  const { data, error } = await service.from("workspace_tags").insert({ org_id: orgId, name, created_by: auth.userId }).select("id, org_id, name, created_at").single();
  if (!error) return ok(auth.headers, { tag: toTag(data as TagRow, 0) });
  // unique_violation on the case-insensitive name key (migration 313): the tag already exists, return it instead of an error.
  if (error.code !== "23505") throw dbError(error);
  const existing = await service.from("workspace_tags").select("id, org_id, name, created_at").eq("org_id", orgId).eq("name_key", name.toLowerCase()).maybeSingle();
  if (existing.error) throw new LookupError("workspace_tags", existing.error);
  if (!existing.data) throw dbError(error);
  return ok(auth.headers, { tag: toTag(existing.data as TagRow, 0), existed: true });
});

export const DELETE = route("/api/workspace/tags", async (request) => {
  const auth = await requireOrgRole(request, "member");
  if (isRefusal(auth)) return auth;
  const input = await parseJson(request, deleteBody);
  const { error } = await serviceClient().from("workspace_tags").delete().eq("id", input.tagId).eq("org_id", auth.membership.orgId);
  if (error) throw dbError(error);
  return ok(auth.headers, { success: true });
});
