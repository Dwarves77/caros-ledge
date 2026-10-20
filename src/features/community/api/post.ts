// Ported from old_repo/src/app/api/community/posts/[id]/route.ts (lines 118-261)
// Ported from old_repo/src/components/community/CommunityRooms.tsx (lines 404-432)
// PATCH (the author edits their own post's title or text) and DELETE (the AUTHOR's own post; a moderator or group admin removes another member's post through POST .../remove, which is moderate_report with a required note). The GET of one post had no caller and is not ported. A read that fails is a 503; a delete
// that touches no row is a 404, never a silent ok. POST cite is the one way a live system item is cited into a thread (it was a browser-side table write): the item must be a verified, live one, and the update runs under the
// caller's row policy (the author, or a group admin or moderator).
import { z } from "zod";

import { dbError, HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";

import { refuseSensitiveText } from "../lib/antitrust";
import { LIMITS } from "../lib/labels";
import { POST_COLUMNS, shapePosts, type PostRow } from "../lib/post-shape";

import { idField, idParam, one } from "./_http";

type Ctx = { params: Promise<{ id: string }> };
const edit = z.object({
  title: z.string().trim().min(1, "A title can't be empty").max(LIMITS.postTitle, `A title is at most ${LIMITS.postTitle} characters`).optional(),
  body: z.string().trim().min(1, "A post can't be empty").max(LIMITS.postBody, `A post is at most ${LIMITS.postBody} characters`).optional(),
});

export const PATCH = route("/api/community/posts/[id]", async (request, ctx: Ctx) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const postId = await idParam(ctx, "id", "post id");
  const input = await parseJson(request, edit);
  const update: { title?: string; body?: string } = {};
  if (input.title !== undefined) update.title = input.title;
  if (input.body !== undefined) update.body = input.body;
  if (Object.keys(update).length === 0) throw new HttpError(400, "Send a title or some text to change");
  const guard = refuseSensitiveText(update.title, update.body);
  if (!guard.allowed) throw new HttpError(403, guard.reason);
  const existing = await one<PostRow>(auth.client.from("community_posts").select(POST_COLUMNS).eq("id", postId).maybeSingle(), "post");
  if (!existing) throw new HttpError(404, "Post not found");
  if (existing.author_user_id !== auth.userId) throw new HttpError(403, "Only the author can edit this post");
  if (update.title !== undefined && existing.parent_post_id !== null) throw new HttpError(400, "A reply has no title");
  const { data, error } = await auth.client.from("community_posts").update(update).eq("id", postId).select(POST_COLUMNS).maybeSingle();
  if (error) throw dbError(error, { forbidden: "You can't edit this post" });
  if (!data) throw new HttpError(403, "You can't edit this post");
  const { posts } = await shapePosts(auth.client, auth.userId, [data as PostRow]);
  return ok(auth.headers, { post: posts[0] });
});

export const DELETE = route("/api/community/posts/[id]", async (request, ctx: Ctx) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const postId = await idParam(ctx, "id", "post id");
  const { data, error } = await auth.client.from("community_posts").delete().eq("id", postId).select("id");
  if (error) throw dbError(error, { forbidden: "You can't delete this post" });
  if (!data || data.length === 0) throw new HttpError(404, "Post not found, or you can't delete it");
  return ok(auth.headers, { ok: true, deleted: data.length });
});

const MAX_CITED = 20;
export const POST_CITE = route("/api/community/posts/[id]/cite", async (request, ctx: Ctx) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const postId = await idParam(ctx, "id", "post id");
  const { item_id: itemId } = await parseJson(request, z.object({ item_id: idField("item") }));
  const item = await one<{ id: string; provenance_status: string | null; is_archived: boolean | null }>(auth.client.from("intelligence_items").select("id, provenance_status, is_archived").eq("id", itemId).maybeSingle(), "item");
  if (!item || item.provenance_status !== "verified" || item.is_archived === true) throw new HttpError(404, "That item is not available to cite");
  const post = await one<{ id: string; referenced_intelligence_item_ids: string[] | null }>(auth.client.from("community_posts").select("id, referenced_intelligence_item_ids").eq("id", postId).maybeSingle(), "post");
  if (!post) throw new HttpError(404, "Post not found");
  const cited = post.referenced_intelligence_item_ids ?? [];
  if (cited.includes(itemId)) return ok(auth.headers, { ok: true, cited });
  if (cited.length >= MAX_CITED) throw new HttpError(409, `A thread can cite ${MAX_CITED} items`);
  const next = [...cited, itemId];
  const { data, error } = await auth.client.from("community_posts").update({ referenced_intelligence_item_ids: next }).eq("id", postId).select("id").maybeSingle();
  if (error) throw dbError(error, { forbidden: "Only the author or a moderator can cite an item here" });
  if (!data) throw new HttpError(403, "Only the author or a moderator can cite an item here");
  return ok(auth.headers, { ok: true, cited: next });
});
