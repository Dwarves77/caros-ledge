// The registers' defect list, one red-first test each (the old tree's behaviour is the failing case): a dropped-error read that became a 403 or a 404, a filter applied after the limit, a silent pagination stop, a
// failure with no sentence. The four wiring defects (invitation panel, toast callbacks, browser-client writes, a mute that did nothing) are in pages.test.ts, actions.test.ts, structure.test.ts and notifications.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import { GET_CANDIDATES, GET_INVITATIONS } from "@/features/community/api/group-invitations";
import { POST as join } from "@/features/community/api/group-join";
import { GET as roster } from "@/features/community/api/group-members";
import { PATCH as settings } from "@/features/community/api/group-settings";
import { POST_DECLINE, POST_REVOKE } from "@/features/community/api/invitation-respond";
import { GET_REPORTS, POST_REPORT } from "@/features/community/api/moderation";
import { PATCH as editPost, POST_CITE } from "@/features/community/api/post";
import { GET as listPosts } from "@/features/community/api/posts";
import { GET as listReplies, POST as reply } from "@/features/community/api/replies";
import { GET as entityThreads, GET_ENTITIES } from "@/features/community/api/entity-threads";
import { GET as profile } from "@/features/community/api/profile";
import { GET as search } from "@/features/community/api/search";

import { call, ENTITY, INVITE, ITEM_LIVE, PUB, T_PUB, USER, world, type Persona, type World } from "./_world.ts";

interface Case {
  name: string;
  handler: Parameters<typeof call>[0];
  as: Persona;
  method: string;
  path: string;
  body?: unknown;
  params?: Record<string, string>;
  fail: [string, "select" | "update" | "insert"];
}
const CASES: Case[] = [
  { name: "group invitations: the caller's role", handler: GET_INVITATIONS, as: "admin", method: "GET", path: `/api/community/groups/${PUB}/invitations`, params: { id: PUB }, fail: ["community_group_members", "select"] },
  { name: "invite candidates: the exclusion reads", handler: GET_CANDIDATES, as: "admin", method: "GET", path: `/api/community/groups/${PUB}/invite-candidates?q=ma`, params: { id: PUB }, fail: ["community_group_bans", "select"] },
  { name: "settings: the group pre-read", handler: settings, as: "admin", method: "PATCH", path: `/api/community/groups/${PUB}/settings`, body: { name: "N" }, params: { id: PUB }, fail: ["community_groups", "select"] },
  { name: "join: the group pre-read", handler: join, as: "nonMember", method: "POST", path: `/api/community/groups/${PUB}/join`, body: {}, params: { id: PUB }, fail: ["community_groups", "select"] },
  { name: "join: the pending-invitation clear", handler: join, as: "nonMember", method: "POST", path: `/api/community/groups/${PUB}/join`, body: {}, params: { id: PUB }, fail: ["community_group_invitations", "update"] },
  { name: "the roster", handler: roster, as: "admin", method: "GET", path: `/api/community/groups/${PUB}/members`, params: { id: PUB }, fail: ["community_group_members", "select"] },
  { name: "decline: the invitation read", handler: POST_DECLINE, as: "nonMember", method: "POST", path: `/api/community/invitations/${INVITE}/decline`, body: {}, params: { id: INVITE }, fail: ["community_group_invitations", "select"] },
  { name: "revoke: the invitation read", handler: POST_REVOKE, as: "admin", method: "POST", path: `/api/community/invitations/${INVITE}/revoke`, body: {}, params: { id: INVITE }, fail: ["community_group_invitations", "select"] },
  { name: "a reply: the thread read", handler: reply, as: "member", method: "POST", path: `/api/community/posts/${T_PUB}/replies`, body: { body: "x" }, params: { id: T_PUB }, fail: ["community_posts", "select"] },
  { name: "an edit: the post read", handler: editPost, as: "member", method: "PATCH", path: `/api/community/posts/${T_PUB}`, body: { body: "x" }, params: { id: T_PUB }, fail: ["community_posts", "select"] },
  { name: "cite: the item read", handler: POST_CITE, as: "member", method: "POST", path: `/api/community/posts/${T_PUB}/cite`, body: { item_id: ITEM_LIVE }, params: { id: T_PUB }, fail: ["intelligence_items", "select"] },
  { name: "a report: the post read", handler: POST_REPORT, as: "member", method: "POST", path: "/api/community/moderation/reports", body: { post_id: T_PUB, reason: "spam" }, fail: ["community_posts", "select"] },
  { name: "the report list", handler: GET_REPORTS, as: "moderator", method: "GET", path: "/api/community/moderation/reports", fail: ["moderation_reports", "select"] },
  { name: "the thread list", handler: listPosts, as: "member", method: "GET", path: `/api/community/posts?group_id=${PUB}`, fail: ["community_posts", "select"] },
  { name: "the reply list", handler: listReplies, as: "member", method: "GET", path: `/api/community/posts/${T_PUB}/replies`, params: { id: T_PUB }, fail: ["community_posts", "select"] },
  { name: "an entity's threads", handler: entityThreads, as: "member", method: "GET", path: `/api/community/entities/${ENTITY}/threads`, params: { entityId: ENTITY }, fail: ["community_thread_entities", "select"] },
  { name: "the entity picker", handler: GET_ENTITIES, as: "member", method: "GET", path: "/api/community/entities?q=eu", fail: ["entities", "select"] },
  { name: "the search", handler: search, as: "member", method: "GET", path: "/api/community/search?q=ma", fail: ["community_groups", "select"] },
  { name: "the profile", handler: profile, as: "member", method: "GET", path: "/api/community/profile", fail: ["community_member_profiles", "select"] },
];
for (const c of CASES) {
  test(`dropped-error reads: ${c.name} that fails is a 503 the client retries, not a 403 or a 404 or an empty answer`, async () => {
    const db = world();
    db.fail(c.fail[0], c.fail[1], "the database refused");
    const res = await call(c.handler, c.as, c.method, c.path, c.body, c.params);
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.ok(res.headers.get("Retry-After"), "the client is told when to retry");
    assert.doesNotMatch(String(res.body.error ?? ""), /refused|community_|public\./, "the database's words are not the customer's");
  });
}

// ── pagination is honest ────────────────────────────────────────────────────────────────────────────────────────

const fill = (db: World, n: number, over: (i: number) => Record<string, unknown>) => {
  for (let i = 0; i < n; i += 1) db.rows("community_posts").push({ id: `dddddddd-0000-4000-8000-00000000${String(100 + i).padStart(4, "0")}`, group_id: PUB, parent_post_id: null, author_user_id: USER.member, title: `T${i}`, body: `B${i}`, created_at: `2026-09-${String(1 + (i % 27)).padStart(2, "0")}T${String(10 + Math.floor(i / 27)).padStart(2, "0")}:00:00.000Z`, last_reply_at: null, reply_count: 0, anonymous: false, ...over(i) });
};

test("silent pagination stop: a full page that ends the list has no cursor, one that does not has one, and walking the cursor reaches every thread once", async () => {
  const db = world();
  for (const p of db.rows("community_posts")) p.group_id = "cccccccc-0000-4000-8000-0000000000ff"; // move the fixtures out of the way
  fill(db, 25, () => ({}));
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res: Awaited<ReturnType<typeof call>> = await call(listPosts, "member", "GET", `/api/community/posts?group_id=${PUB}&limit=10${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
    seen.push(...(res.body.posts as Array<{ id: string }>).map((p) => p.id));
    cursor = res.body.next_cursor as string | null;
    pages += 1;
  } while (cursor && pages < 10);
  assert.deepEqual([pages, seen.length, new Set(seen).size], [3, 25, 25]);
  const exact = world();
  for (const p of exact.rows("community_posts")) p.group_id = "cccccccc-0000-4000-8000-0000000000ff";
  fill(exact, 10, () => ({}));
  assert.equal((await call(listPosts, "member", "GET", `/api/community/posts?group_id=${PUB}&limit=10`)).body.next_cursor, null, "exactly a page: nothing more, no phantom next page");
});

test("replies read oldest first with an honest 'after' cursor (the old 'before' filtered the other way)", async () => {
  const db = world();
  db.tables.community_posts = db.rows("community_posts").filter((p) => p.parent_post_id === null);
  for (let i = 0; i < 12; i += 1) db.rows("community_posts").push({ id: `dddddddd-0000-4000-8000-00000000${String(300 + i).padStart(4, "0")}`, group_id: PUB, parent_post_id: T_PUB, author_user_id: USER.moderator, title: null, body: `R${i}`, created_at: `2026-10-01T10:${String(i).padStart(2, "0")}:00.000Z`, last_reply_at: null, reply_count: 0, anonymous: false });
  const first = await call(listReplies, "member", "GET", `/api/community/posts/${T_PUB}/replies?limit=5`, undefined, { id: T_PUB });
  const bodies = (r: typeof first) => (r.body.replies as Array<{ body: string }>).map((x) => x.body);
  assert.deepEqual(bodies(first), ["R0", "R1", "R2", "R3", "R4"]);
  const second = await call(listReplies, "member", "GET", `/api/community/posts/${T_PUB}/replies?limit=5&after=${encodeURIComponent(String(first.body.next_cursor))}`, undefined, { id: T_PUB });
  assert.deepEqual(bodies(second), ["R5", "R6", "R7", "R8", "R9"]);
  const third = await call(listReplies, "member", "GET", `/api/community/posts/${T_PUB}/replies?limit=5&after=${encodeURIComponent(String(second.body.next_cursor))}`, undefined, { id: T_PUB });
  assert.deepEqual([bodies(third), third.body.next_cursor], [["R10", "R11"], null]);
  assert.equal((await call(listReplies, "member", "GET", `/api/community/posts/${T_PUB}/replies?limit=0`, undefined, { id: T_PUB })).status, 400);
  assert.equal((await call(listReplies, "member", "GET", `/api/community/posts/${T_PUB}/replies?after=yesterday`, undefined, { id: T_PUB })).status, 400);
});

test("a filter after the limit: the status and reason of the report list are in the query, so an old open report is found behind a screen of newer resolved ones", async () => {
  const db = world();
  for (let i = 0; i < 30; i += 1) db.rows("moderation_reports").push({ id: `eeeeeeee-0000-4000-8000-00000000${String(500 + i).padStart(4, "0")}`, target_kind: "post", target_id: T_PUB, reporter_user_id: USER.member, reason: "spam", status: "resolved", created_at: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T12:00:00.000Z` });
  const open = await call(GET_REPORTS, "moderator", "GET", "/api/community/moderation/reports?status=open&limit=20");
  const reports = open.body.reports as Array<{ status: string }>;
  assert.equal(reports.length, 1, "the one open report is on the first page");
  assert.equal(reports[0]?.status, "open");
  const dismissed = await call(GET_REPORTS, "moderator", "GET", "/api/community/moderation/reports?status=dismissed");
  assert.deepEqual(dismissed.body.reports, [], "an empty answer is a true one, not a filtered page");
  assert.equal((await call(GET_REPORTS, "moderator", "GET", "/api/community/moderation/reports?status=nonsense")).status, 400);
  const mine = await call(GET_REPORTS, "member", "GET", "/api/community/moderation/reports?reason=spam&limit=100");
  assert.ok((mine.body.reports as Array<{ is_mine: boolean }>).every((r) => r.is_mine), "a plain member sees what they filed");
  assert.ok((mine.body.reports as Array<{ can_review: boolean }>).every((r) => !r.can_review), "and is offered no action");
});

test("the thread list is the top-level threads only: a reply is never a row of it (the parent filter is part of the query)", async () => {
  world();
  const res = await call(listPosts, "member", "GET", `/api/community/posts?group_id=${PUB}`);
  const rows = res.body.posts as Array<{ parent_post_id: string | null }>;
  assert.ok(rows.length >= 2 && rows.every((r) => r.parent_post_id === null));
});
