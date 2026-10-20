// INV-076: the persona matrix for every Community handler: anonymous, a signed-in user who is in no group, a member, a moderator, a group admin, an active verifier, a platform admin, and a member of another organisation.
// The row policies are emulated in the world (tests/community/_world.ts), so a handler that leans on a policy is proven against it, not against a permissive stub.
import assert from "node:assert/strict";
import { test } from "node:test";
import dns from "node:dns/promises";

import { PATCH as settings } from "@/features/community/api/group-settings";
import { PATCH_MUTE, PATCH_STAR } from "@/features/community/api/group-prefs";
import { POST as join } from "@/features/community/api/group-join";
import { DELETE as leave, GET as roster } from "@/features/community/api/group-members";
import { GET_CANDIDATES, GET_INVITATIONS, POST_INVITE } from "@/features/community/api/group-invitations";
import { POST as createGroup } from "@/features/community/api/groups";
import { POST_ACCEPT, POST_DECLINE, POST_REVOKE } from "@/features/community/api/invitation-respond";
import { GET as listPosts, POST as createPost } from "@/features/community/api/posts";
import { DELETE as deletePost, PATCH as editPost, POST_CITE } from "@/features/community/api/post";
import { GET as listReplies, POST as reply } from "@/features/community/api/replies";
import { GET as entityThreads, GET_ENTITIES } from "@/features/community/api/entity-threads";
import { POST_DECIDE, POST_REQUEST, POST_WITHDRAW } from "@/features/community/api/signoff";
import { GET_REPORTS, POST_ACT, POST_REPORT } from "@/features/community/api/moderation";
import { GET as listNotifications, GET_COUNTS, POST as markAll, POST_ONE } from "@/features/community/api/notifications";
import { GET as getProfile, GET_VERIFY, POST_VERIFY, PUT as putProfile } from "@/features/community/api/profile";
import { GET as search } from "@/features/community/api/search";

import { call, E, ENTITY, INVITE, ITEM_LIVE, matrix, PRIV, PUB, REPORT, SIGNOFF, STRANGER, T_HIDDEN, T_PUB } from "./_world.ts";

process.env.COMMUNITY_ORG_SALT = "test-salt-test-salt-test-salt";
// The expectations read in the order of PERSONAS: anon, nonMember, member, moderator, admin, verifier, platformAdmin, otherOrg.
const M = (name: string, h: Parameters<typeof call>[0], method: string, path: string, body: unknown, expected: ReturnType<typeof E>, params: Record<string, string> = {}) =>
  test(`INV-076 ${name}`, () => matrix(name, async (p) => (await call(h, p, method, path, body, params)).status, expected));

M("POST groups", createGroup, "POST", "/api/community/groups", { name: "Reefer Room", vertical: "fine-art" }, E(401, 201, 201, 201, 201, 201, 201, 201));
M("PATCH group settings: only the owner or a group admin (a moderator passes the route and the row policy refuses)", settings, "PATCH", `/api/community/groups/${PUB}/settings`, { name: "Renamed" }, E(401, 403, 403, 403, 200, 403, 403, 403), { id: PUB });
M("POST join a public group", join, "POST", `/api/community/groups/${PUB}/join`, {}, E(401, 200, 200, 200, 200, 200, 200, 200), { id: PUB });
M("POST join a private group is a 404 for a stranger and refused for a member who is outside it", join, "POST", `/api/community/groups/${PRIV}/join`, {}, E(401, 404, 403, 403, 403, 404, 404, 404), { id: PRIV });
M("GET roster", roster, "GET", `/api/community/groups/${PUB}/members`, undefined, E(401, 200, 200, 200, 200, 200, 200, 200), { id: PUB });
M("DELETE leave (the last admin cannot leave)", leave, "DELETE", `/api/community/groups/${PUB}/members`, undefined, E(401, 404, 200, 200, 409, 404, 404, 404), { id: PUB });
M("PATCH star", PATCH_STAR, "PATCH", `/api/community/groups/${PUB}/star`, { starred: true }, E(401, 404, 200, 200, 200, 404, 404, 404), { id: PUB });
M("PATCH mute", PATCH_MUTE, "PATCH", `/api/community/groups/${PUB}/mute`, { muted: true }, E(401, 404, 200, 200, 200, 404, 404, 404), { id: PUB });
M("GET invitations: a reviewer", GET_INVITATIONS, "GET", `/api/community/groups/${PUB}/invitations`, undefined, E(401, 403, 403, 200, 200, 403, 403, 403), { id: PUB });
M("GET invite candidates: an admin", GET_CANDIDATES, "GET", `/api/community/groups/${PUB}/invite-candidates?q=ma`, undefined, E(401, 403, 403, 403, 200, 403, 403, 403), { id: PUB });
M("POST invite: an admin", POST_INVITE, "POST", `/api/community/groups/${PUB}/invite`, { invitee_user_id: STRANGER }, E(401, 403, 403, 403, 200, 403, 403, 403), { id: PUB });
M("POST accept: the invitee only", POST_ACCEPT, "POST", `/api/community/invitations/${INVITE}/accept`, {}, E(401, 200, 403, 403, 403, 403, 403, 403), { id: INVITE });
M("POST decline: the invitee only (others cannot even see it)", POST_DECLINE, "POST", `/api/community/invitations/${INVITE}/decline`, {}, E(401, 200, 404, 403, 403, 404, 404, 404), { id: INVITE });
M("POST revoke: the inviter or a group admin", POST_REVOKE, "POST", `/api/community/invitations/${INVITE}/revoke`, {}, E(401, 403, 404, 403, 200, 404, 404, 404), { id: INVITE });
M("GET threads of a group", listPosts, "GET", `/api/community/posts?group_id=${PUB}`, undefined, E(401, 200, 200, 200, 200, 200, 200, 200));
M("POST a thread: members only", createPost, "POST", "/api/community/posts", { group_id: PUB, title: "T", body: "B", entity_ids: [ENTITY] }, E(401, 403, 201, 201, 201, 403, 403, 403));
M("PATCH a post: the author only", editPost, "PATCH", `/api/community/posts/${T_PUB}`, { title: "Edited" }, E(401, 403, 200, 403, 403, 403, 403, 403), { id: T_PUB });
M("DELETE a post: the author or a reviewer (row policy)", deletePost, "DELETE", `/api/community/posts/${T_PUB}`, undefined, E(401, 404, 200, 200, 200, 404, 404, 404), { id: T_PUB });
M("POST cite: the author or a reviewer", POST_CITE, "POST", `/api/community/posts/${T_PUB}/cite`, { item_id: ITEM_LIVE }, E(401, 403, 200, 200, 200, 403, 403, 403), { id: T_PUB });
M("GET replies", listReplies, "GET", `/api/community/posts/${T_PUB}/replies`, undefined, E(401, 200, 200, 200, 200, 200, 200, 200), { id: T_PUB });
M("POST a reply: members only", reply, "POST", `/api/community/posts/${T_PUB}/replies`, { body: "Agreed" }, E(401, 403, 201, 201, 201, 403, 403, 403), { id: T_PUB });
M("GET threads of an entity", entityThreads, "GET", `/api/community/entities/${ENTITY}/threads`, undefined, E(401, 200, 200, 200, 200, 200, 200, 200), { entityId: ENTITY });
M("GET entities", GET_ENTITIES, "GET", "/api/community/entities?q=eur", undefined, E(401, 200, 200, 200, 200, 200, 200, 200));
M("POST sign-off request: members of the room", POST_REQUEST, "POST", `/api/community/posts/${T_HIDDEN}/signoff`, {}, E(401, 403, 201, 201, 201, 403, 403, 403), { id: T_HIDDEN });
M("POST sign-off decide: an active verifier or a platform admin", POST_DECIDE, "POST", `/api/community/signoff/${SIGNOFF}/decide`, { decision: "signed_off", primary_doc_url: "https://eur-lex.europa.eu/x" }, E(401, 403, 403, 403, 403, 200, 200, 403), { id: SIGNOFF });
M("POST sign-off withdraw: the requester", POST_WITHDRAW, "POST", `/api/community/signoff/${SIGNOFF}/withdraw`, {}, E(401, 404, 200, 404, 404, 404, 404, 404), { id: SIGNOFF });
M("GET reports", GET_REPORTS, "GET", "/api/community/moderation/reports", undefined, E(401, 200, 200, 200, 200, 200, 200, 200));
M("POST a report: members of the post's group", POST_REPORT, "POST", "/api/community/moderation/reports", { post_id: T_PUB, reason: "spam" }, E(401, 403, 201, 201, 201, 403, 403, 403));
M("POST act on a report: a reviewer of its group or a platform admin", POST_ACT, "POST", `/api/community/moderation/reports/${REPORT}`, { action: "warn" }, E(401, 403, 403, 200, 200, 403, 200, 403), { id: REPORT });
M("GET notifications", listNotifications, "GET", "/api/community/notifications", undefined, E(401, 200, 200, 200, 200, 200, 200, 200));
M("POST mark all read", markAll, "POST", "/api/community/notifications", { action: "mark_all_read" }, E(401, 200, 200, 200, 200, 200, 200, 200));
M("POST mark one read (not found for everyone here)", POST_ONE, "POST", `/api/community/notifications/${T_PUB}`, { action: "mark_read" }, E(401, 404, 404, 404, 404, 404, 404, 404), { id: T_PUB });
M("GET notification counts", GET_COUNTS, "GET", "/api/community/notifications/counts", undefined, E(401, 200, 200, 200, 200, 200, 200, 200));
M("GET profile", getProfile, "GET", "/api/community/profile", undefined, E(401, 200, 200, 200, 200, 200, 200, 200));
M("PUT profile", putProfile, "PUT", "/api/community/profile", { org_type: "forwarder" }, E(401, 200, 200, 200, 200, 200, 200, 200));
dns.resolveTxt = async () => Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" })); // no test reaches the network: the proof record is never there
M("POST verify (the record is not published: nobody is verified by asking)", POST_VERIFY, "POST", "/api/community/profile/verify", {}, E(401, 409, 409, 409, 409, 409, 409, 409));
M("GET verify (the record to publish)", GET_VERIFY, "GET", "/api/community/profile/verify", undefined, E(401, 200, 200, 200, 200, 200, 200, 200));
M("GET search", search, "GET", "/api/community/search?q=ma", undefined, E(401, 200, 200, 200, 200, 200, 200, 200));

test("a private group's threads are read by its members only (the row policy, not the route)", async () => {
  await matrix(
    "private threads",
    async (p) => {
      const res = await call(listPosts, p, "GET", `/api/community/posts?group_id=${PRIV}`);
      if (res.status === 401) return 401;
      assert.equal(res.status, 200);
      return (res.body.posts as unknown[]).length;
    },
    { anon: 401, nonMember: 0, member: 1, moderator: 1, admin: 1, verifier: 0, platformAdmin: 0, otherOrg: 0 },
  );
});
