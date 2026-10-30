// Ported from old_repo/src/app/api/community/posts/route.ts (lines 148-408)
// GET a group's threads (newest first, a cursor that knows whether there is more) and POST a thread. A thread is bound to 1 to 10 spine entities and refused when its title or text states a sensitive figure BEFORE anything is written;
// the post and its links are then one transaction (create_thread, INV-236), and the anonymity is resolved there. Authors come from the one shaper: the id of an anonymous author reaches only the author and an admin.
import { z } from "zod";

import { HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { dbError } from "@/core/http/errors";
import { parseJson, parseWith } from "@/core/http/parse";

import { refuseSensitiveText } from "../lib/antitrust";
import { validateEntityIds } from "../lib/entity-binding";
import { LIMITS } from "../lib/labels";
import { POST_COLUMNS, shapePosts, type PostRow } from "../lib/post-shape";

import { cursorParam, idField, limitParam, many, mutedSentence } from "./_http";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export const GET = route("/api/community/posts", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const url = new URL(request.url);
  const groupId = parseWith(idField("group id"), url.searchParams.get("group_id"), "request");
  const limit = limitParam(url, DEFAULT_LIMIT, MAX_LIMIT);
  const before = cursorParam(url, "before");
  let query = auth.client.from("community_posts").select(POST_COLUMNS).eq("group_id", groupId).is("parent_post_id", null).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (before) query = query.lt("created_at", before);
  const rows = await many<PostRow>(query, "threads");
  const page = rows.slice(0, limit);
  const { posts, identityFailed } = await shapePosts(auth.client, auth.userId, page);
  return ok(auth.headers, { posts, next_cursor: rows.length > limit ? (page[page.length - 1]?.created_at ?? null) : null, identity_failed: identityFailed });
});

const create = z.object({
  group_id: idField("group"),
  title: z.string().trim().min(1, "A thread needs a title").max(LIMITS.postTitle, `A title is at most ${LIMITS.postTitle} characters`),
  body: z.string().trim().min(1, "A thread needs some text").max(LIMITS.postBody, `A post is at most ${LIMITS.postBody} characters`),
  entity_ids: z.array(z.string()).default([]),
  anonymous: z.boolean().optional(),
});

export const POST = route("/api/community/posts", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const input = await parseJson(request, create);
  const binding = validateEntityIds(input.entity_ids);
  if (!binding.ok) throw new HttpError(400, binding.error);
  const guard = refuseSensitiveText(input.title, input.body);
  if (!guard.allowed) throw new HttpError(403, guard.reason);
  const { data, error } = await auth.client.rpc("create_thread", { p_group_id: input.group_id, p_title: input.title, p_body: input.body, p_anonymous: input.anonymous ?? null, p_entity_ids: binding.entityIds });
  if (error) {
    const muted = mutedSentence(error);
    if (muted) throw new HttpError(403, muted);
    if (error.code === "22023") throw new HttpError(400, "A chosen entity does not exist.");
    if (error.code === "23503") throw new HttpError(404, "Group not found");
    throw dbError(error, { forbidden: "Only group members may post" });
  }
  const row = data as PostRow & { entity_ids: string[] };
  const { posts } = await shapePosts(auth.client, auth.userId, [row]);
  return ok(auth.headers, { post: { ...posts[0], entity_ids: row.entity_ids } }, 201);
});
