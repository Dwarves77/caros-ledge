// Ported from old_repo/src/app/api/community/posts/route.ts (lines 32-112)
// Ported from old_repo/src/app/api/community/posts/[id]/route.ts (lines 19-83)
// Ported from old_repo/src/app/api/community/posts/[id]/replies/route.ts (lines 21-69)
// The one post row, the one column list and the one shaper for threads, replies and a single post (three copies drifted: only the thread list returned an identity block). An author is built once per row from
// the identity rpc and the member profile; a failed identity read degrades every author to anonymous and says so.
import type { Db } from "@/core/db/clients";

import { authorOf, communityViewer, loadIdentities, loadMemberProfiles } from "./identity";
import type { PostView } from "./types";

export const POST_COLUMNS = "id, group_id, parent_post_id, author_user_id, title, body, created_at, last_reply_at, reply_count, anonymous, signed_off_at";

export interface PostRow {
  id: string;
  group_id: string;
  parent_post_id: string | null;
  author_user_id: string | null;
  title: string | null;
  body: string;
  created_at: string;
  last_reply_at: string | null;
  reply_count: number | null;
  anonymous: boolean | null;
  signed_off_at: string | null;
}

/** Rows to views for one reader. A failed member-profile read throws; a failed identity read sets `identityFailed` and withholds every author's name and id. */
export async function shapePosts(db: Db, userId: string, rows: PostRow[]): Promise<{ posts: PostView[]; identityFailed: boolean }> {
  const authorIds = [...new Set(rows.map((r) => r.author_user_id).filter((id): id is string => !!id))];
  const [{ byId, error }, members] = await Promise.all([loadIdentities(db, authorIds), loadMemberProfiles(db, authorIds)]);
  const viewer = await communityViewer(db, userId, rows, byId);
  const posts = rows.map((r) => ({
    id: r.id,
    group_id: r.group_id,
    parent_post_id: r.parent_post_id,
    title: r.title,
    body: r.body,
    created_at: r.created_at,
    last_reply_at: r.last_reply_at,
    reply_count: r.reply_count ?? 0,
    signed_off_at: r.signed_off_at,
    author: authorOf({ authorUserId: r.author_user_id, postAnonymous: r.anonymous, identity: r.author_user_id ? (byId.get(r.author_user_id) ?? null) : null, member: r.author_user_id ? (members.get(r.author_user_id) ?? null) : null, viewer }),
  }));
  return { posts, identityFailed: error !== null };
}
