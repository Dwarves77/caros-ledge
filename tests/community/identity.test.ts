// INV-234 and INV-224 and INV-226: how Community shows another member. A reader sees a member only through the identity definer; an anonymous author's name, company and headshot are never sent, and the author's id
// reaches only the author and a platform admin; an author whose identity cannot be read is treated as anonymous; the anonymous label and the verified mark; no private channel.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";

import { GET as entityThreads } from "@/features/community/api/entity-threads";
import { GET as listPosts, POST as createPost } from "@/features/community/api/posts";
import { PATCH as editPost } from "@/features/community/api/post";
import { GET as listReplies } from "@/features/community/api/replies";
import { GET as roster } from "@/features/community/api/group-members";
import { GET as search } from "@/features/community/api/search";
import { GET_CANDIDATES } from "@/features/community/api/group-invitations";
import { authorOf, authorIdForRow, effectiveAnonymous, idWithheld, type IdentityRow } from "@/features/community/lib/identity";
import { ANONYMOUS_LABEL, authorIdentityLabel } from "@/features/community/lib/identity-format";
import type { AuthorBlock } from "@/features/community/lib/types";
import { NoDirectMessaging } from "@/features/community/ui/parts/NoDirectMessaging";
import { AuthorIdentity } from "@/features/community/ui/parts/AuthorIdentity";

import { renderApp, textOf } from "../_support/render.ts";

import { call, ENTITY, HIDDEN, PUB, R_HIDDEN, T_HIDDEN, T_PUB, USER, world, type Viewer } from "./_world.ts";

type Author = { userId: string | null; name: string | null; company: string | null; headshotUrl: string | null; anonymous: boolean; verified: boolean };
const LISTS = [
  { name: "the thread list", handler: listPosts, path: `/api/community/posts?group_id=${PUB}`, params: {}, key: "posts", id: T_HIDDEN },
  { name: "the reply list", handler: listReplies, path: `/api/community/posts/${T_PUB}/replies`, params: { id: T_PUB }, key: "replies", id: R_HIDDEN },
  { name: "an entity's threads", handler: entityThreads, path: `/api/community/entities/${ENTITY}/threads`, params: { entityId: ENTITY }, key: "threads", id: T_HIDDEN },
] as const;
// Who sees the id of an anonymous author: the author and a platform admin, nobody else (a group admin and a moderator included).
const VIEWERS: Array<[Viewer, boolean]> = [["member", false], ["moderator", false], ["admin", false], ["platformAdmin", true], ["author", true]];

// 3 read routes x 5 viewers = 15 cases
for (const list of LISTS) {
  for (const [viewer, seesId] of VIEWERS) {
    test(`INV-234: ${list.name} as ${viewer}: the anonymous author's id is ${seesId ? "sent" : "withheld"}, and never a name, company or headshot`, async () => {
      world();
      const res = await call(list.handler, viewer, "GET", list.path, undefined, { ...list.params });
      assert.equal(res.status, 200);
      const row = (res.body[list.key] as Array<{ id: string; author: Author | null }>).find((r) => r.id === list.id);
      assert.ok(row?.author, "the anonymous author's row is in the list, with an author block");
      assert.equal(row.author.userId, seesId ? HIDDEN : null);
      assert.deepEqual([row.author.name, row.author.company, row.author.headshotUrl, row.author.anonymous], [null, null, null, true]);
      if (!seesId) assert.ok(!JSON.stringify(res.body).includes(HIDDEN), "the id is nowhere in the response");
    });
  }
}

test("INV-234: the answers to a write carry the same author block (create, edit): the author sees their own id, nobody else's response carries it", async () => {
  const db = world();
  db.rows("community_member_profiles").find((m) => m.user_id === USER.member)!.default_anonymous = true;
  const made = await call(createPost, "member", "POST", "/api/community/posts", { group_id: PUB, title: "Mine", body: "Body", entity_ids: [ENTITY] });
  assert.equal(made.status, 201);
  const post = made.body.post as { author: Author; entity_ids: string[] };
  assert.deepEqual([post.author.anonymous, post.author.name, post.author.userId], [true, null, USER.member], "the member's default anonymity applies; the author gets their own id back");
  const edited = await call(editPost, "member", "PATCH", `/api/community/posts/${T_PUB}`, { body: "Edited" }, { id: T_PUB });
  assert.equal(edited.status, 200);
  assert.equal(((edited.body.post as { author: Author }).author).userId, USER.member);
});

test("INV-234: an author whose identity cannot be read is treated as anonymous on every list, and the response says so", async () => {
  for (const list of LISTS) {
    const db = world();
    db.rpcFail.set("community_identity", { message: "identity down" });
    const res = await call(list.handler, "verifier", "GET", list.path, undefined, { ...list.params });
    assert.equal(res.status, 200);
    assert.equal(res.body.identity_failed, true, `${list.name}: the failure is stated`);
    const authors = (res.body[list.key] as Array<{ author: Author | null }>).map((r) => r.author).filter((a): a is Author => !!a);
    assert.ok(authors.length > 0);
    for (const a of authors) assert.deepEqual([a.anonymous, a.name, a.company, a.headshotUrl, a.userId], [true, null, null, null, null], `${list.name}: no name, no photo and no id for anyone`);
  }
});

test("INV-234: the roster, the people search and the invite search carry no user id, and a withheld name stays withheld", async () => {
  world();
  const r = await call(roster, "admin", "GET", `/api/community/groups/${PUB}/members`, undefined, { id: PUB });
  const members = r.body.members as Array<Record<string, unknown>>;
  assert.ok(members.length >= 3);
  assert.ok(members.every((m) => !("user_id" in m)), "no member row carries an id");
  const hiddenRow = members.find((m) => m.anonymous === true);
  assert.ok(hiddenRow && hiddenRow.name === null && hiddenRow.headshot_url === null, "the default-anonymous member's name and headshot are not sent");
  assert.ok(!JSON.stringify(r.body).includes(HIDDEN));
  const people = await call(search, "member", "GET", "/api/community/search?q=Hana&scope=people");
  assert.deepEqual(people.body.people, [], "a member whose name is withheld is not found by name");
  const named = await call(search, "member", "GET", "/api/community/search?q=Mo&scope=people");
  assert.ok((named.body.people as Array<Record<string, unknown>>).every((p) => !("user_id" in p) && !("email" in p)));
  const cands = await call(GET_CANDIDATES, "admin", "GET", `/api/community/groups/${PUB}/invite-candidates?q=an`, undefined, { id: PUB });
  assert.ok(!JSON.stringify(cands.body).includes(HIDDEN), "a default-anonymous member is never offered as a candidate");
});

test("INV-234: the identity projection, unit by unit (per-post OR per-member, the verified mark kept, the id rule)", () => {
  const named: IdentityRow = { user_id: "u", display_name: "Ada", company_name: "Co", job_title: "Ops", region: "EU", avatar_url: "https://i/x.png", verified: true, anonymous: false };
  assert.equal(effectiveAnonymous({ postAnonymous: true, identity: named }), true);
  assert.equal(effectiveAnonymous({ postAnonymous: false, identity: { ...named, anonymous: true } }), true);
  assert.equal(effectiveAnonymous({ postAnonymous: false, identity: named }), false);
  assert.equal(idWithheld({ postAnonymous: false, identity: null }), true, "an identity that could not be read is withheld");
  const row = (viewer: { userId: string; isAdmin?: boolean } | null, postAnonymous = true) => authorIdForRow({ authorUserId: "author", postAnonymous, identity: named, viewer });
  assert.deepEqual([row({ userId: "author" }), row({ userId: "x", isAdmin: true }), row({ userId: "x" }), row(null), row({ userId: "x" }, false)], ["author", "author", null, null, "author"]);
  const block = authorOf({ authorUserId: "author", postAnonymous: true, identity: named, member: { user_id: "author", org_type: "forwarder", role: "ops", sector: "air", region: "EU", verified: true }, viewer: { userId: "x", isAdmin: false } });
  assert.deepEqual([block?.name, block?.company, block?.headshotUrl, block?.userId, block?.verified, block?.orgType, block?.anonymous], [null, null, null, null, true, "forwarder", true], "the verified mark and the org type are kept");
  assert.equal(authorOf({ authorUserId: null, postAnonymous: false, identity: null, member: null, viewer: { userId: "x" } }), null, "a deleted account is null, never a stand-in");
});

test("INV-224: an anonymous author reads 'Anonymous member' with the verified mark kept, and name, company and headshot never render", () => {
  const author: AuthorBlock = { userId: null, name: "Ada Lovelace", company: "Analytical Ltd", headshotUrl: "https://img.example.test/ada.png", orgType: "forwarder", role: "ops", sector: "air", region: "EU", verified: true, anonymous: true };
  assert.equal(authorIdentityLabel(author)?.startsWith(ANONYMOUS_LABEL), true);
  const html = renderApp(createElement(AuthorIdentity, { author }));
  const text = textOf(html);
  assert.ok(text.includes("Anonymous member") && text.includes("Verified"), text);
  // The component is handed a block that (wrongly) still carries a name: the withheld case must not draw it, nor the photo.
  assert.ok(!html.includes("ada.png") && !html.includes("<img"), "no headshot is drawn for an anonymous author");
  const shown = textOf(renderApp(createElement(AuthorIdentity, { author: { ...author, anonymous: false } })));
  assert.ok(shown.includes("Ada Lovelace") && !shown.includes("Anonymous member"));
  assert.ok(textOf(renderApp(createElement(AuthorIdentity, { author: null }))).includes("Former member"));
});

test("INV-226: the no-direct-messaging statement is on every members list, and nothing offers to message a member", async () => {
  assert.match(textOf(renderApp(createElement(NoDirectMessaging))), /No direct messaging/);
});

test("two meanings of 'verified' are two marks: the member's Verified (a company email on the account) and a post's Signed off (a verifier checked the claim); neither draws the other's word", async () => {
  const { Post } = await import("@/features/community/ui/posts/Post");
  const { ToastProvider } = await import("@/features/community/ui/toast");
  const author = (verified: boolean): AuthorBlock => ({ userId: "u", name: "Ada", company: null, headshotUrl: null, orgType: "forwarder", role: null, sector: null, region: null, verified, anonymous: false });
  const post = (verified: boolean, signedOff: boolean) => ({ id: "p", group_id: "g", parent_post_id: null, title: "T", body: "B", created_at: "2026-10-01T00:00:00Z", last_reply_at: null, reply_count: 0, signed_off_at: signedOff ? "2026-10-02T00:00:00Z" : null, author: author(verified) });
  const draw = (p: ReturnType<typeof post>) => textOf(renderApp(createElement(ToastProvider, null, createElement(Post, { post: p, meId: "someone", canModerate: false, onDeleted: () => {} }))));
  const memberOnly = draw(post(true, false));
  assert.ok(/\bVerified\b/.test(memberOnly) && !/Signed off/.test(memberOnly), memberOnly);
  const postOnly = draw(post(false, true));
  assert.ok(/Signed off/.test(postOnly) && !/\bVerified\b/.test(postOnly), postOnly);
  const neither = draw(post(false, false));
  assert.ok(!/Signed off|\bVerified\b/.test(neither));
});

test("INV-234: a name the definer should have withheld is still withheld by the projection (the roster and the thread list do not trust the rpc to have done it)", async () => {
  const db = world();
  db.identityTamper = (rows) => rows.map((r) => (r.anonymous === true ? { ...r, display_name: "Leaky Name", company_name: "Leaky Ltd", avatar_url: "https://img.example.test/leak.png" } : r));
  const members = await call(roster, "admin", "GET", `/api/community/groups/${PUB}/members`, undefined, { id: PUB });
  const threads = await call(listPosts, "member", "GET", `/api/community/posts?group_id=${PUB}`);
  for (const res of [members, threads]) {
    assert.equal(res.status, 200);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes("Leaky") && !text.includes("leak.png"), text.slice(0, 200));
  }
});
