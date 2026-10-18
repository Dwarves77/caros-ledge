// Ported from old_repo/src/app/api/community/entities/[entityId]/threads/route.ts (lines 11-123)
// GET the threads bound to one spine entity across every group the caller can read (the link rows inherit the thread's visibility). Two plain reads in place of an embed: the links newest first, then their top-level
// posts; the group names ride along so a digest can say where each thread lives. Authors come from the one shaper.
import { HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { entityKindOf } from "@/core/entities/kinds";

import { loadEntityCandidates } from "../lib/entity-candidates";
import { POST_COLUMNS, shapePosts, type PostRow } from "../lib/post-shape";

import { cursorParam, limitParam, many } from "./_http";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export const GET = route("/api/community/entities/[entityId]/threads", async (request, ctx: { params: Promise<{ entityId: string }> }) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const { entityId } = await ctx.params;
  const kind = entityKindOf(entityId);
  if (!kind) throw new HttpError(400, "That is not a valid entity");
  const url = new URL(request.url);
  const limit = limitParam(url, DEFAULT_LIMIT, MAX_LIMIT);
  const before = cursorParam(url, "before");
  let links = auth.client.from("community_thread_entities").select("thread_id, entity_kind, created_at").eq("entity_id", entityId).order("created_at", { ascending: false }).order("thread_id", { ascending: false }).limit(limit + 1);
  if (before) links = links.lt("created_at", before);
  const linkRows = await many<{ thread_id: string; entity_kind: string | null; created_at: string }>(links, "entity threads");
  const page = linkRows.slice(0, limit);
  const posts = page.length ? await many<PostRow>(auth.client.from("community_posts").select(POST_COLUMNS).in("id", page.map((l) => l.thread_id)).is("parent_post_id", null).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(MAX_LIMIT), "threads") : [];
  const groupIds = [...new Set(posts.map((p) => p.group_id))];
  const groups = groupIds.length ? await many<{ id: string; name: string; slug: string }>(auth.client.from("community_groups").select("id, name, slug").in("id", groupIds), "groups") : [];
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const shaped = await shapePosts(auth.client, auth.userId, posts);
  const threads = shaped.posts.map((p) => ({ ...p, entity_id: entityId, entity_kind: kind, group_name: groupById.get(p.group_id)?.name ?? null, group_slug: groupById.get(p.group_id)?.slug ?? null }));
  return ok(auth.headers, { entity_id: entityId, threads, next_cursor: linkRows.length > limit ? (page[page.length - 1]?.created_at ?? null) : null, identity_failed: shaped.identityFailed });
});

/** GET /api/community/entities?q=: the active spine entities a thread can be bound to, by name (the wildcards in the query escaped), for the picker; replaces the page-level URL round trip. */
export const GET_ENTITIES = route("/api/community/entities", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 100);
  return ok(auth.headers, { entities: await loadEntityCandidates(auth.client, q) });
});
