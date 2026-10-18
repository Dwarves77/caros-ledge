// Ported from old_repo/src/app/api/community/posts/[id]/replies/route.ts (lines 71-266)
// GET a thread's replies oldest first with an honest `after` cursor (the old `before` filtered the other way), POST a reply one level deep. The reply notifies the thread's author through the outbox, which applies the
// recipient's preferences and mute; the payload carries no reply-author id (an anonymous replier must not be linkable). A failed queue never undoes the reply.
import { z } from "zod";

import { dbError, HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";
import { queueNotifications } from "@/core/notifications";
import { log } from "@/core/shared/log";

import { LIMITS } from "../lib/labels";
import { POST_COLUMNS, shapePosts, type PostRow } from "../lib/post-shape";

import { cursorParam, idParam, limitParam, many, mutedSentence, one, visibleGroup } from "./_http";

type Ctx = { params: Promise<{ id: string }> };
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const excerpt = (text: string): string => (text.length > 120 ? `${text.slice(0, 117).trimEnd()}...` : text);

export const GET = route("/api/community/posts/[id]/replies", async (request, ctx: Ctx) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const parentId = await idParam(ctx, "id", "post id");
  const url = new URL(request.url);
  const limit = limitParam(url, DEFAULT_LIMIT, MAX_LIMIT);
  const after = cursorParam(url, "after");
  let query = auth.client.from("community_posts").select(POST_COLUMNS).eq("parent_post_id", parentId).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(limit + 1);
  if (after) query = query.gt("created_at", after);
  const rows = await many<PostRow>(query, "replies");
  const page = rows.slice(0, limit);
  const { posts, identityFailed } = await shapePosts(auth.client, auth.userId, page);
  return ok(auth.headers, { replies: posts, next_cursor: rows.length > limit ? (page[page.length - 1]?.created_at ?? null) : null, identity_failed: identityFailed });
});

export const POST = route("/api/community/posts/[id]/replies", async (request, ctx: Ctx) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const parentId = await idParam(ctx, "id", "post id");
  const { body } = await parseJson(request, z.object({ body: z.string().trim().min(1, "A reply can't be empty").max(LIMITS.replyBody, `A reply is at most ${LIMITS.replyBody} characters`) }));
  const parent = await one<{ id: string; group_id: string; parent_post_id: string | null; author_user_id: string | null }>(auth.client.from("community_posts").select("id, group_id, parent_post_id, author_user_id").eq("id", parentId).maybeSingle(), "thread");
  if (!parent) throw new HttpError(404, "Thread not found");
  if (parent.parent_post_id !== null) throw new HttpError(400, "A reply can't be answered; reply to the thread");
  const { data, error } = await auth.client.from("community_posts").insert({ group_id: parent.group_id, parent_post_id: parentId, author_user_id: auth.userId, title: null, body }).select(POST_COLUMNS).maybeSingle();
  const muted = error ? mutedSentence(error) : null;
  if (muted) throw new HttpError(403, muted);
  if (error) throw dbError(error, { forbidden: "Only group members may reply" });
  if (!data) throw new HttpError(403, "Only group members may reply");
  const { posts } = await shapePosts(auth.client, auth.userId, [data as PostRow]);
  let notified = true;
  if (parent.author_user_id && parent.author_user_id !== auth.userId) {
    const group = await visibleGroup<{ id: string; name: string; slug: string }>(auth.client, parent.group_id, "id, name, slug");
    const queued = await queueNotifications([{ userId: parent.author_user_id, kind: "reply", payload: { title: `New reply in ${group.name}`, body: excerpt(body), link: `/community/${group.slug}`, group_id: parent.group_id, parent_post_id: parent.id, reply_post_id: (data as PostRow).id } }]);
    if (queued) log.warn("[community] the reply was saved but its notification was not queued:", queued);
    notified = queued === null;
  }
  return ok(auth.headers, { reply: posts[0], notified }, 201);
});
