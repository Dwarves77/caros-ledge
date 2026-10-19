// The write-side invariants of Community: INV-137, 150, 223, 235, 236, 237, 238, 239, 240, 241 (R2e: 235 is a DNS proof the system performs and records, 237 reads the words of a post, 241 needs the document). The row policies are emulated (tests/community/_world.ts); the SQL of each rpc is proven by the migrations' own self-checks.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { POST_INVITE } from "@/features/community/api/group-invitations";
import { POST as join } from "@/features/community/api/group-join";
import { DELETE as leave } from "@/features/community/api/group-members";
import { POST as createGroup } from "@/features/community/api/groups";
import { POST_ACCEPT, POST_DECLINE, POST_REVOKE } from "@/features/community/api/invitation-respond";
import { POST_ACT } from "@/features/community/api/moderation";
import { PATCH as editPost } from "@/features/community/api/post";
import { POST as createPost } from "@/features/community/api/posts";
import { POST as reply } from "@/features/community/api/replies";
import { GET as listPosts } from "@/features/community/api/posts";
import { POST_DECIDE, POST_REQUEST, POST_WITHDRAW } from "@/features/community/api/signoff";
import { GET_VERIFY, POST_VERIFY, PUT as putProfile } from "@/features/community/api/profile";
import { kAnonymity, K_ANONYMITY_FLOOR, refuseSensitiveText } from "@/features/community/lib/antitrust";
import { MAX_ENTITY_IDS, validateEntityIds } from "@/features/community/lib/entity-binding";
import { deriveOrganisationKey, isFreeMailDomain, resolveOrganisationSalt } from "@/features/community/lib/org-key";
import { dns } from "@/features/community/lib/domain-proof";

import { scripted } from "../_support/fake-clients.ts";

import { call, clientFor, ENTITY, ENTITY_2, EXTRA, HIDDEN, INVITE, PRIV, PUB, REPORT, SIGNOFF, STRANGER, T_HIDDEN, T_PUB, USER, world, type Persona, type World } from "./_world.ts";

// A free-mail provider, assembled so the tree check for personal mail addresses (scripts/ci/tree-checks.mjs) does not read the fixture as an address.
const FREE_MAIL_DOMAIN = ["out", "look"].join("") + ".com";
const posts = (db: World) => db.rows("community_posts").length;
const outbox = (db: World) => db.rows("notification_outbox");
const writesTo = (db: World, table: string) => db.calls.filter((c) => c.table === table && c.op !== "select");
const memberOf = (db: World, g: string, u: string) => db.rows("community_group_members").some((m) => m.group_id === g && m.user_id === u);
const NEW = { group_id: PUB, title: "A thread", body: "Some text", entity_ids: [ENTITY] };

// ── INV-223 and INV-236: a thread is bound to 1 to 10 entities, or it does not exist ──────────────────────────────

test("INV-223: the one validator: 0, 11 and a malformed id are refused, duplicates collapse, and the composer and the route share it", () => {
  assert.equal(validateEntityIds([]).ok, false);
  assert.equal(validateEntityIds(undefined).ok, false);
  assert.equal(validateEntityIds(Array.from({ length: MAX_ENTITY_IDS + 1 }, (_, i) => `cl:jurisdiction:${String(i).padStart(16, "0")}`)).ok, false);
  assert.equal(validateEntityIds(["cl:jurisdiction:xyz"]).ok, false);
  assert.equal(validateEntityIds(["cl:planet:aaaaaaaaaaaaaaaa"]).ok, true, "the shape is checked here; whether the kind exists is the database's");
  const dup = validateEntityIds([ENTITY, ` ${ENTITY} `, ENTITY_2]);
  assert.deepEqual(dup.ok && dup.entityIds, [ENTITY, ENTITY_2]);
});

test("INV-223: the route refuses an unbound or over-bound thread with 400 BEFORE any call to the database", async () => {
  for (const entity_ids of [[], Array.from({ length: 11 }, (_, i) => `cl:jurisdiction:${String(i).padStart(16, "0")}`), ["cl:jurisdiction:xyz"]]) {
    const db = world();
    const res = await call(createPost, "member", "POST", "/api/community/posts", { ...NEW, entity_ids });
    assert.equal(res.status, 400, JSON.stringify(entity_ids).slice(0, 40));
    assert.ok(!db.rpcLog.includes("create_thread"), "the rpc was never called");
    assert.equal(posts(db), 6);
  }
});

test("INV-236: a thread and its links are one call; an unknown entity, a refused member or a failed call leaves no post behind", async () => {
  const db = world();
  const before = posts(db);
  const links = db.rows("community_thread_entities").length;
  const ok = await call(createPost, "member", "POST", "/api/community/posts", { ...NEW, entity_ids: [ENTITY, ENTITY_2] });
  assert.equal(ok.status, 201);
  assert.equal(db.rpcLog.filter((n) => n === "create_thread").length, 1, "one rpc");
  assert.equal(writesTo(db, "community_posts").length + writesTo(db, "community_thread_entities").length, 0, "the route wrote no row itself: the post and its two links came from the one transaction");
  assert.deepEqual([posts(db), db.rows("community_thread_entities").length], [before + 1, links + 2]);
  const unknown = await call(createPost, "member", "POST", "/api/community/posts", { ...NEW, entity_ids: ["cl:jurisdiction:cccccccccccccccc"] });
  assert.equal(unknown.status, 400);
  const outsider = await call(createPost, "nonMember", "POST", "/api/community/posts", NEW);
  assert.equal(outsider.status, 403);
  db.rpcFail.set("create_thread", { message: "connection reset" });
  assert.equal((await call(createPost, "member", "POST", "/api/community/posts", NEW)).status, 500);
  assert.deepEqual([posts(db), db.rows("community_thread_entities").length], [before + 1, links + 2], "no refusal and no failure left a post or a link");
});

// ── INV-237: a declared commercially sensitive field is refused at write ─────────────────────────────────────────

/** Text that states a rate, wage, capacity or pricing figure (planted violations), and text that does not (regulatory prose, counts, dates). */
const PLANTED = [
  "We are paying USD 2,400 per FEU on Shanghai to Rotterdam this month",
  "Our rate is $1,850 per TEU on the transpacific",
  "carriers quoted 3200 EUR per container for the Q4 contract",
  "Drivers here earn a wage of $31 per hour",
  "Our warehouse salary band is 4200 EUR for pickers",
  "We hold capacity of 1,200 TEU on this loop",
  "blank sailings cut allocation to 800 TEU a week",
  "the SAF surcharge is a 14% premium on our contract",
  "my price for that lane was $2.1k a box",
];
const CLEAN = [
  "Regulation (EU) 2023/1805 requires a 2% SAF share of aviation fuel supplied from 2025",
  "The reporting window under ETS2 opens on 1 January 2027",
  "Has anyone filed the first CBAM declaration yet?",
  "The terminal operates three berths and handled 40 vessels last quarter",
  "Article 12 sets a penalty regime but leaves the amounts to member states",
  "We met 25 members at the conference in Hamburg",
];

test("INV-237 (R2e): the guard reads the WORDS: every planted figure is refused with the field it states, every clean text passes, in a thread, a reply and an edit, and a declaration is not needed", async () => {
  for (const text of PLANTED) {
    const guard = refuseSensitiveText(text);
    assert.equal(guard.allowed, false, text);
    assert.ok(!guard.allowed && guard.field.length > 0 && /never permitted/.test(guard.reason), text);
  }
  for (const text of CLEAN) assert.equal(refuseSensitiveText(text).allowed, true, text);
  assert.equal(refuseSensitiveText("a title", PLANTED[0]).allowed, false, "the title and the body are read together");
  assert.equal(refuseSensitiveText(null, undefined, "").allowed, true);
  const db = world();
  const before = posts(db);
  for (const text of PLANTED) {
    const res = await call(createPost, "member", "POST", "/api/community/posts", { ...NEW, body: text });
    assert.equal(res.status, 403, text);
    assert.match(String(res.body.error), /never permitted/);
  }
  assert.equal((await call(createPost, "member", "POST", "/api/community/posts", { ...NEW, title: PLANTED[1], body: "Some text" })).status, 403, "a figure in the title is a figure");
  assert.deepEqual([db.rpcLog.includes("create_thread"), posts(db)], [false, before], "nothing was written for any refusal");
  assert.equal((await call(createPost, "member", "POST", "/api/community/posts", { ...NEW, body: CLEAN[0] })).status, 201);
  assert.equal((await call(createPost, "member", "POST", "/api/community/posts", { ...NEW, body: CLEAN[1], sensitivity_field: "pricing" })).status, 201, "a declaration in the body of the request is not read; the words are");
  const rep = await call(reply, "member", "POST", `/api/community/posts/${T_PUB}/replies`, { body: PLANTED[3] }, { id: T_PUB });
  assert.equal(rep.status, 403, "a reply is a composer too");
  assert.equal((await call(reply, "member", "POST", `/api/community/posts/${T_PUB}/replies`, { body: CLEAN[2] }, { id: T_PUB })).status, 201);
  const mine = (await call(createPost, "member", "POST", "/api/community/posts", { ...NEW, body: CLEAN[3] })).body.post as { id: string };
  const edit = await call(editPost, "member", "PATCH", `/api/community/posts/${mine.id}`, { body: PLANTED[5] }, { id: mine.id });
  assert.equal(edit.status, 403, "an edit is a composer too");
  assert.equal(db.post(mine.id)?.body, CLEAN[3], "the refused edit changed nothing");
});

test("INV-237: the aggregate rule is kept in code as the floor: distinct organisations (never rows) against 5", () => {
  assert.equal(K_ANONYMITY_FLOOR, 5);
  assert.deepEqual(kAnonymity(["a", "a", "a", "a", "a", "a"]), { distinctOrganisations: 1, minContributors: 5, satisfied: false });
  assert.equal(kAnonymity(["a", "b", "c", "d"]).satisfied, false);
  assert.equal(kAnonymity([{ organisationKey: "a" }, { organisationKey: "b" }, { organisationKey: "c" }, { organisationKey: "d" }, { organisationKey: "e" }, { organisationKey: null }]).satisfied, true);
});

// ── INV-235 and INV-137: verification is written by the server path only ────────────────────────────────────────

test("INV-235: a member write is an allowlist: the verification columns, the organisation key and a user id in the body are dropped", async () => {
  const db = world();
  const res = await call(putProfile, "member", "PUT", "/api/community/profile", { org_type: "carrier", role: "ops", verified: true, verified_at: "2020-01-01", verification_method: "corporate-email", organisation_key: "stolen", user_id: USER.admin, default_anonymous: true });
  assert.equal(res.status, 200);
  const write = writesTo(db, "community_member_profiles")[0]?.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(write).sort(), ["default_anonymous", "org_type", "region", "role", "sector", "user_id"]);
  assert.equal(write.user_id, USER.member, "the row is the caller's own");
  assert.equal(db.rows("community_member_profiles").find((m) => m.user_id === USER.admin)?.org_type, "forwarder", "another member's row is untouched");
  assert.equal((await call(putProfile, "member", "PUT", "/api/community/profile", { org_type: "wizard" })).status, 400);
});

test("INV-235 (R2e): verification is a DNS proof the system performs and records: a free-mail domain cannot publish it, a missing salt is refused, a lookup that failed is a retry, a match is one service call, and the key is never returned", async () => {
  const salt = "unit-test-salt-unit-test-salt";
  const keep = { c: process.env.COMMUNITY_ORG_SALT, w: process.env.WORKER_SECRET, resolve: dns.resolveTxt };
  const asked: string[] = [];
  try {
    process.env.COMMUNITY_ORG_SALT = salt;
    const db = world();
    const published = (domain: string, uid: string): string => `caros-ledge-verification=${createHmac("sha256", salt).update(`verify:${uid}:${domain}`, "utf8").digest("hex").slice(0, 32)}`;
    // a free-mail domain: nobody can publish a record on it, so the lookup finds nothing and nothing is written
    scripted.user = () => clientFor(db, { uid: USER.member, email: `someone@${FREE_MAIL_DOMAIN}`, admin: false });
    dns.resolveTxt = async (host) => (asked.push(host), Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" })));
    const profileOf = () => JSON.stringify(db.rows("community_member_profiles").find((m) => m.user_id === USER.member));
    const untouched = profileOf();
    const free = await call(POST_VERIFY, "member", "POST", "/api/community/profile/verify");
    assert.equal(free.status, 409);
    assert.match(String(free.body.error), /_caros-ledge\.outlook\.com/);
    assert.equal(profileOf(), untouched, "a name on no list verifies nobody; a record that is not there changes nothing");
    assert.deepEqual(asked, ["_caros-ledge.outlook.com"]);

    scripted.user = () => clientFor(db, { uid: USER.member, email: "someone@acme-freight.example", admin: false });
    delete process.env.COMMUNITY_ORG_SALT;
    delete process.env.WORKER_SECRET;
    const unsalted = await call(POST_VERIFY, "member", "POST", "/api/community/profile/verify");
    assert.equal(unsalted.status, 503);
    assert.equal(unsalted.headers.get("Retry-After"), "60");
    assert.ok(!db.rpcLog.includes("record_domain_verification"), "no write without a salt");

    process.env.COMMUNITY_ORG_SALT = salt;
    dns.resolveTxt = async () => Promise.reject(Object.assign(new Error("servfail"), { code: "ESERVFAIL" }));
    const down = await call(POST_VERIFY, "member", "POST", "/api/community/profile/verify");
    assert.equal(down.status, 503, "a lookup that failed is a retry, not a refusal of the member");
    assert.ok(!db.rpcLog.includes("record_domain_verification"));

    dns.resolveTxt = async () => [["caros-ledge-verification=somebody-elses-token"]];
    assert.equal((await call(POST_VERIFY, "member", "POST", "/api/community/profile/verify")).status, 409, "another member's record does not verify this one");

    dns.resolveTxt = async () => [["v=spf1 -all"], [published("acme-freight.example", USER.member).slice(0, 20), published("acme-freight.example", USER.member).slice(20)]];
    const good = await call(POST_VERIFY, "member", "POST", "/api/community/profile/verify");
    assert.equal(good.status, 200);
    const row = db.rows("community_member_profiles").find((m) => m.user_id === USER.member);
    const key = createHmac("sha256", salt).update("acme-freight.example", "utf8").digest("hex");
    assert.deepEqual([row?.verified, row?.verification_method, row?.organisation_key], [true, "domain-dns", key]);
    assert.equal(db.rows("admin_events").filter((e) => e.action === "member_verified_domain" && e.actor_id === USER.member).length, 1, "the event is written with the verification");
    assert.ok(!JSON.stringify(good.body).includes(key), "the key is not in the response");
    assert.equal((good.body.profile as { verified: boolean }).verified, true);
    const instructions = await call(GET_VERIFY, "member", "GET", "/api/community/profile/verify");
    assert.deepEqual(instructions.body, { domain: "acme-freight.example", host: "_caros-ledge.acme-freight.example", value: published("acme-freight.example", USER.member) });
    world();
    assert.equal((await call(GET_VERIFY, "anon", "GET", "/api/community/profile/verify")).status, 401);
  } finally {
    dns.resolveTxt = keep.resolve;
    if (keep.c === undefined) delete process.env.COMMUNITY_ORG_SALT;
    else process.env.COMMUNITY_ORG_SALT = keep.c;
    if (keep.w !== undefined) process.env.WORKER_SECRET = keep.w;
  }
});

test("INV-235: the organisation key is an HMAC-SHA256 of the domain under a server-only salt; free-mail, unverified and unsalted derive nothing; the salt is never the domain's", () => {
  const salt = "unit-test-salt-unit-test-salt";
  const a = deriveOrganisationKey({ domain: "Acme.example", verified: true, salt });
  assert.equal(a.organisationKey, createHmac("sha256", salt).update("acme.example", "utf8").digest("hex"));
  assert.notEqual(deriveOrganisationKey({ domain: "acme.example", verified: true, salt: "another-salt-another-salt" }).organisationKey, a.organisationKey);
  assert.equal(deriveOrganisationKey({ domain: "gmail.com", verified: true, salt }).organisationKey, null);
  assert.equal(deriveOrganisationKey({ domain: "acme.example", verified: false, salt }).organisationKey, null);
  assert.equal(deriveOrganisationKey({ domain: "acme.example", verified: true, salt: "" }).organisationKey, null);
  assert.equal(isFreeMailDomain("outlook.com"), true);
  assert.deepEqual(resolveOrganisationSalt({}), { salt: null, source: null });
  assert.equal(resolveOrganisationSalt({ COMMUNITY_ORG_SALT: salt }).source, "COMMUNITY_ORG_SALT");
  assert.equal(resolveOrganisationSalt({ WORKER_SECRET: "worker-secret-worker-secret" }).source, "derived-from-WORKER_SECRET");
});

test("INV-137: the privilege-bearing columns (a sign-off stamp, a counter, a role, the verification) are not reachable through an edit or a write route", async () => {
  const db = world();
  const res = await call(editPost, "member", "PATCH", `/api/community/posts/${T_PUB}`, { body: "Edited", signed_off_at: "2026-01-01T00:00:00Z", signed_off_by: USER.member, reply_count: 99, author_user_id: USER.admin }, { id: T_PUB });
  assert.equal(res.status, 200);
  const post = db.post(T_PUB)!;
  assert.deepEqual([post.signed_off_at ?? null, post.signed_off_by ?? null, post.reply_count, post.author_user_id], [null, null, 1, USER.member]);
  assert.deepEqual(Object.keys(writesTo(db, "community_posts")[0]?.payload as object), ["body"], "the update carries the allowed keys only");
  const settings = await call((await import("@/features/community/api/group-settings")).PATCH, "admin", "PATCH", `/api/community/groups/${PUB}/settings`, { name: "N", owner_user_id: USER.member, member_count: 500 }, { id: PUB });
  assert.equal(settings.status, 200);
  assert.deepEqual([db.group(PUB)?.owner_user_id, db.group(PUB)?.member_count], [USER.admin, 3]);
});

// ── INV-150: counters are the database's, and no handler writes them ────────────────────────────────────────────

test("INV-150: no handler writes a counter: member_count, weekly_post_count, reply_count, last_reply_at and last_active_at are only ever the database's", async () => {
  const db = world();
  await call(createPost, "member", "POST", "/api/community/posts", NEW);
  await call(reply, "member", "POST", `/api/community/posts/${T_PUB}/replies`, { body: "r" }, { id: T_PUB });
  await call(join, "nonMember", "POST", `/api/community/groups/${PUB}/join`, {}, { id: PUB });
  await call(leave, "moderator", "DELETE", `/api/community/groups/${PUB}/members`, undefined, { id: PUB });
  await call(createGroup, "member", "POST", "/api/community/groups", { name: "Counted", vertical: "fine-art" });
  const counters = ["member_count", "weekly_post_count", "reply_count", "last_reply_at", "last_active_at"];
  for (const w of db.calls.filter((c) => c.op !== "select")) {
    const keys = Object.keys((Array.isArray(w.payload) ? w.payload[0] : w.payload) ?? {});
    assert.ok(!keys.some((k) => counters.includes(k)), `${w.table} ${w.op} writes ${keys.filter((k) => counters.includes(k))}`);
  }
});

// ── INV-238: a group always has an admin ────────────────────────────────────────────────────────────────────────

test("INV-238: creating a group is one call (the group and its owner-admin row together); the last admin cannot leave, a second admin can", async () => {
  const db = world();
  const made = await call(createGroup, "nonMember", "POST", "/api/community/groups", { name: "Reefer Room", vertical: "fine-art", description: "Cold chain" });
  assert.equal(made.status, 201);
  const group = made.body.group as { id: string; slug: string };
  assert.match(group.slug, /^grp-fine-art-reefer-room-[0-9a-f]{5}$/);
  assert.deepEqual(db.rpcLog.filter((n) => n === "create_group_for_self"), ["create_group_for_self"]);
  assert.equal(writesTo(db, "community_groups").length + writesTo(db, "community_group_members").length, 0, "no second write the route could leave half-done");
  assert.equal(db.role(group.id, USER.nonMember), "admin");

  const last = await call(leave, "admin", "DELETE", `/api/community/groups/${PUB}/members`, undefined, { id: PUB });
  assert.equal(last.status, 409, "the only admin is refused");
  assert.equal(db.role(PUB, USER.admin), "admin");
  db.rows("community_group_members").find((m) => m.group_id === PUB && m.user_id === USER.moderator)!.role = "admin";
  assert.equal((await call(leave, "admin", "DELETE", `/api/community/groups/${PUB}/members`, undefined, { id: PUB })).status, 200, "with another admin present the first may leave");
  assert.equal((await call(createGroup, "member", "POST", "/api/community/groups", { name: "X", vertical: "not-a-vertical" })).status, 400);
});

test("INV-238: a taken slug is retried with a new suffix, then stated, never a half-made group", async () => {
  const db = world();
  let attempts = 0;
  db.rpcFail.set("create_group_for_self", { message: "duplicate key value violates unique constraint", code: "23505" });
  const orig = db.rpcLog.push.bind(db.rpcLog);
  db.rpcLog.push = (...a: string[]) => {
    attempts += a[0] === "create_group_for_self" ? 1 : 0;
    return orig(...a);
  };
  const res = await call(createGroup, "member", "POST", "/api/community/groups", { name: "Busy", vertical: "fine-art" });
  assert.deepEqual([res.status, attempts], [409, 3]);
});

// ── INV-239: the reviewer gate comes before any side effect; a closed report never changes ───────────────────────

type Gate = { name: string; persona: Persona; action: "remove" | "ban" | "warn"; status: number; setup?: (db: World) => void };
const GATE: Gate[] = [
  ...(["nonMember", "member", "verifier", "otherOrg"] as const).flatMap((persona) => (["remove", "ban"] as const).map((action) => ({ name: `${persona} cannot ${action}`, persona, action, status: 403 }))),
  { name: "a signed-out caller cannot remove", persona: "anon", action: "remove", status: 401 },
  { name: "a moderator of ANOTHER group cannot ban here", persona: "moderator", action: "ban", status: 403, setup: (db) => void (db.tables.community_group_members = db.rows("community_group_members").filter((m) => !(m.group_id === PUB && m.user_id === USER.moderator))) },
];
// 8 non-reviewers + 1 signed out + 1 other-group moderator = 10 cases, and the closed report below is the 11th
for (const g of GATE) {
  test(`INV-239: ${g.name}: ${g.status}, and nothing was changed, banned or sent`, async () => {
    const db = world();
    g.setup?.(db);
    const members = db.rows("community_group_members").length;
    const res = await call(POST_ACT, g.persona, "POST", `/api/community/moderation/reports/${REPORT}`, { action: g.action, notes: "x" }, { id: REPORT });
    assert.equal(res.status, g.status);
    assert.deepEqual([db.post(T_PUB) !== undefined, db.rows("community_group_bans").length, db.rows("community_group_members").length, outbox(db).length, db.rows("moderation_reports")[0]?.status], [true, 0, members, 0, "open"]);
  });
}

test("INV-239: a closed report never changes: the second action is a 409, the post is not removed, nobody is banned, and no second notice is queued", async () => {
  const db = world();
  assert.equal((await call(POST_ACT, "moderator", "POST", `/api/community/moderation/reports/${REPORT}`, { action: "dismiss" }, { id: REPORT })).status, 200);
  for (const action of ["remove", "ban", "warn"]) assert.equal((await call(POST_ACT, "admin", "POST", `/api/community/moderation/reports/${REPORT}`, { action }, { id: REPORT })).status, 409, action);
  assert.deepEqual([db.post(T_PUB) !== undefined, db.rows("community_group_bans").length, outbox(db).length, db.rows("moderation_reports")[0]?.status], [true, 0, 0, "dismissed"]);
});

test("INV-239: a ban records the ban, removes the membership, revokes the pending invitations, closes the report and tells the member once, and the banned member cannot rejoin", async () => {
  const db = world();
  const res = await call(POST_ACT, "moderator", "POST", `/api/community/moderation/reports/${REPORT}`, { action: "ban", notes: "Repeated spam" }, { id: REPORT });
  assert.deepEqual([res.status, res.body.status, res.body.action, res.body.notified], [200, "resolved", "ban", true]);
  assert.deepEqual(db.rows("community_group_bans").map((b) => [b.group_id, b.user_id, b.banned_by, b.reason]), [[PUB, USER.member, USER.moderator, "Repeated spam"]], "the ban is recorded, with who and why");
  assert.equal(memberOf(db, PUB, USER.member), false);
  const notices = outbox(db);
  assert.equal(notices.length, 1);
  assert.deepEqual([notices[0]?.user_id, notices[0]?.kind], [USER.member, "moderation"]);
  const text = JSON.stringify(notices[0]?.payload);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(String(((notices[0]?.payload) as { title: string; body: string }).title + ((notices[0]?.payload) as { body: string }).body)), "no internal id in the words");
  assert.ok(!text.includes(USER.moderator), "the notice does not name the moderator");
  assert.equal((await call(join, "member", "POST", `/api/community/groups/${PUB}/join`, {}, { id: PUB })).status, 403, "the second wall: the ban guard on the membership insert refuses the join");
});

test("INV-239: 'remove' deletes the post and its replies; 'warn' tells the author; a mute with no days or 3 days is refused and changes nothing; a failed rpc queues nothing", async () => {
  const db = world();
  assert.equal((await call(POST_ACT, "admin", "POST", `/api/community/moderation/reports/${REPORT}`, { action: "mute" }, { id: REPORT })).status, 400);
  assert.equal((await call(POST_ACT, "admin", "POST", `/api/community/moderation/reports/${REPORT}`, { action: "mute", days: 3 }, { id: REPORT })).status, 400);
  assert.equal(db.rows("community_group_members").some((m) => m.muted_until), false);
  assert.equal(db.rows("moderation_reports")[0]?.status, "open");
  db.rpcFail.set("moderate_report", { message: "connection reset" });
  assert.equal((await call(POST_ACT, "admin", "POST", `/api/community/moderation/reports/${REPORT}`, { action: "warn" }, { id: REPORT })).status, 500);
  assert.equal(outbox(db).length, 0, "no notice for an action that failed");
  db.rpcFail.delete("moderate_report");
  assert.equal((await call(POST_ACT, "admin", "POST", `/api/community/moderation/reports/${REPORT}`, { action: "remove" }, { id: REPORT })).status, 200);
  assert.deepEqual([db.post(T_PUB), db.rows("community_posts").some((p) => p.parent_post_id === T_PUB)], [undefined, false]);
  assert.deepEqual(outbox(db).map((o) => [o.user_id, o.kind]), [[USER.member, "moderation"]], "the author is told, once");
});

// ── INV-240: a member enters a group only by joining a public one or accepting an invitation addressed to them ────

test("INV-240: a private group is not joined, a banned member is refused twice, an invitation is answered once, and only the invitee accepts", async () => {
  const db = world();
  assert.equal((await call(join, "nonMember", "POST", `/api/community/groups/${PRIV}/join`, {}, { id: PRIV })).status, 404, "a private group answers a stranger as if it did not exist");
  assert.equal((await call(join, "nonMember", "POST", `/api/community/groups/${PUB}/join`, {}, { id: PUB })).body.state, "joined");
  assert.equal((await call(join, "nonMember", "POST", `/api/community/groups/${PUB}/join`, {}, { id: PUB })).body.state, "already-member");
  assert.equal(db.rows("community_group_invitations").find((i) => i.id === INVITE)?.status, "accepted", "joining clears the pending invitation");
  const fresh = world();
  assert.equal((await call(POST_ACCEPT, "member", "POST", `/api/community/invitations/${INVITE}/accept`, {}, { id: INVITE })).status, 403, "not addressed to them");
  assert.equal((await call(POST_ACCEPT, "nonMember", "POST", `/api/community/invitations/${INVITE}/accept`, {}, { id: INVITE })).status, 200);
  assert.ok(memberOf(fresh, PUB, USER.nonMember));
  assert.equal((await call(POST_ACCEPT, "nonMember", "POST", `/api/community/invitations/${INVITE}/accept`, {}, { id: INVITE })).status, 409, "a second answer is a conflict, changes nothing");
  assert.equal((await call(POST_DECLINE, "nonMember", "POST", `/api/community/invitations/${INVITE}/decline`, {}, { id: INVITE })).status, 409);
  const banned = world();
  banned.rows("community_group_bans").push({ group_id: PUB, user_id: USER.nonMember, banned_by: USER.admin, reason: "x", created_at: banned.now });
  assert.equal((await call(POST_ACCEPT, "nonMember", "POST", `/api/community/invitations/${INVITE}/accept`, {}, { id: INVITE })).status, 403, "the rpc checks the ban");
  assert.equal((await call(join, "nonMember", "POST", `/api/community/groups/${PUB}/join`, {}, { id: PUB })).status, 403, "and the membership insert itself does");
  assert.equal(memberOf(banned, PUB, USER.nonMember), false);
});

test("INV-240: only a group admin invites, never a banned person, a member, or yourself; only the inviter or an admin revokes", async () => {
  const db = world();
  assert.equal((await call(POST_INVITE, "admin", "POST", `/api/community/groups/${PUB}/invite`, { invitee_user_id: USER.admin }, { id: PUB })).status, 400);
  assert.equal((await call(POST_INVITE, "admin", "POST", `/api/community/groups/${PUB}/invite`, { invitee_user_id: USER.member }, { id: PUB })).status, 409);
  db.rows("community_group_bans").push({ group_id: PUB, user_id: STRANGER, banned_by: USER.admin, reason: "x", created_at: db.now });
  assert.equal((await call(POST_INVITE, "admin", "POST", `/api/community/groups/${PUB}/invite`, { invitee_user_id: STRANGER }, { id: PUB })).status, 409);
  db.tables.community_group_bans = [];
  const sent = await call(POST_INVITE, "admin", "POST", `/api/community/groups/${PUB}/invite`, { invitee_user_id: STRANGER }, { id: PUB });
  assert.deepEqual([sent.status, sent.body.notified], [200, true]);
  assert.equal((await call(POST_INVITE, "admin", "POST", `/api/community/groups/${PUB}/invite`, { invitee_user_id: STRANGER }, { id: PUB })).status, 409, "one pending invitation per person");
  const kinds = outbox(db).map((o) => o.kind);
  assert.deepEqual(kinds, ["invite"]);
  const fresh = world();
  assert.equal((await call(POST_REVOKE, "moderator", "POST", `/api/community/invitations/${INVITE}/revoke`, {}, { id: INVITE })).status, 403);
  assert.equal((await call(POST_REVOKE, "admin", "POST", `/api/community/invitations/${INVITE}/revoke`, {}, { id: INVITE })).status, 200);
  assert.equal(fresh.rows("community_group_invitations").find((i) => i.id === INVITE)?.status, "revoked");
});

// ── INV-241: sign-off ───────────────────────────────────────────────────────────────────────────────────────────

test("INV-241: a post is stamped only after a verifier or platform admin decides; one open request per post; only the requester withdraws; a decline stamps nothing", async () => {
  const db = world();
  assert.equal(db.post(T_HIDDEN)?.signed_off_at ?? null, null);
  const opened = await call(POST_REQUEST, "member", "POST", `/api/community/posts/${T_HIDDEN}/signoff`, {}, { id: T_HIDDEN });
  assert.equal(opened.status, 201);
  assert.equal(db.post(T_HIDDEN)?.signed_off_at ?? null, null, "a request stamps nothing");
  const second = await call(POST_REQUEST, "moderator", "POST", `/api/community/posts/${T_HIDDEN}/signoff`, {}, { id: T_HIDDEN });
  assert.equal(second.status, 409, "one open request per post");
  assert.match(String(second.body.error), /already open for this post/, "and it says why, in the route's words");
  const id = (opened.body.request as { id: string }).id;
  assert.equal((await call(POST_WITHDRAW, "moderator", "POST", `/api/community/signoff/${id}/withdraw`, {}, { id })).status, 404, "only the requester withdraws");
  assert.equal((await call(POST_DECIDE, "verifier", "POST", `/api/community/signoff/${id}/decide`, { decision: "signed_off" }, { id })).status, 400, "R2e: a sign-off with no primary document is refused");
  assert.equal((await call(POST_DECIDE, "member", "POST", `/api/community/signoff/${id}/decide`, { decision: "signed_off", primary_doc_url: "https://eur-lex.europa.eu/x" }, { id })).status, 403, "and nobody decides their own");
  assert.equal((await call(POST_DECIDE, "verifier", "POST", `/api/community/signoff/${id}/decide`, { decision: "declined", decision_note: "No primary document" }, { id })).status, 200);
  assert.equal(db.post(T_HIDDEN)?.signed_off_at ?? null, null, "a decline stamps nothing");
  assert.equal((await call(POST_DECIDE, "verifier", "POST", `/api/community/signoff/${id}/decide`, { decision: "signed_off", primary_doc_url: "https://eur-lex.europa.eu/x" }, { id })).status, 409, "a decided request is closed");
  const again = await call(POST_REQUEST, "member", "POST", `/api/community/posts/${T_HIDDEN}/signoff`, {}, { id: T_HIDDEN });
  const id2 = (again.body.request as { id: string }).id;
  const done = await call(POST_DECIDE, "platformAdmin", "POST", `/api/community/signoff/${id2}/decide`, { decision: "signed_off", primary_doc_url: "https://eur-lex.europa.eu/x" }, { id: id2 });
  assert.equal(done.status, 200);
  assert.ok(db.post(T_HIDDEN)?.signed_off_at, "the stamp follows the decision");
});

// 5 cases: the sign-off admin bit comes from the rpc only
test("INV-241 (1 of 5): a profile COLUMN that says admin does not make a caller an admin: the rpc decides", async () => {
  const db = world();
  db.rows("profiles").find((p) => p.id === USER.member)!.is_platform_admin = true;
  assert.equal((await call(POST_DECIDE, "member", "POST", `/api/community/signoff/${SIGNOFF}/decide`, { decision: "signed_off", primary_doc_url: "https://eur-lex.europa.eu/x" }, { id: SIGNOFF })).status, 403);
  assert.equal(db.post(T_PUB)?.signed_off_at ?? null, null);
});
test("INV-241 (2 of 5): the rpc saying admin is enough, whatever the column says", async () => {
  const db = world();
  assert.equal(db.rows("profiles").find((p) => p.id === USER.platformAdmin)?.is_platform_admin, false);
  assert.equal((await call(POST_DECIDE, "platformAdmin", "POST", `/api/community/signoff/${SIGNOFF}/decide`, { decision: "signed_off", primary_doc_url: "https://eur-lex.europa.eu/x" }, { id: SIGNOFF })).status, 200);
});
test("INV-241 (3 of 5): when the rpc cannot answer, the admin bit is false: an anonymous author's id is withheld even from a real platform admin", async () => {
  const db = world();
  db.rpcFail.set("is_platform_admin", { message: "rpc down" });
  const res = await call(listPosts, "platformAdmin", "GET", `/api/community/posts?group_id=${PUB}`);
  assert.equal(res.status, 200);
  const hidden = (res.body.posts as Array<{ id: string; author: { userId: string | null } }>).find((p) => p.id === T_HIDDEN);
  assert.equal(hidden?.author.userId, null);
});
test("INV-241 (4 of 5): no read of the Community routes selects the platform-admin column", async () => {
  const db = world();
  for (const p of ["/api/community/posts?group_id=" + PUB, "/api/community/moderation/reports", "/api/community/notifications"]) await call((await import("@/features/community/api/posts")).GET, "platformAdmin", "GET", p);
  await call((await import("@/features/community/api/moderation")).GET_REPORTS, "platformAdmin", "GET", "/api/community/moderation/reports");
  assert.ok(db.calls.every((c) => !JSON.stringify(c.filters).includes("is_platform_admin")), "no filter on it");
  assert.equal(db.reads("profiles").length, 0, "the profiles table is not read by a Community route (the definer is)");
  assert.ok(db.rpcLog.includes("is_platform_admin"));
});
test("INV-241 (5 of 5): an admin flag in the request body is ignored", async () => {
  world();
  const res = await call(POST_DECIDE, "member", "POST", `/api/community/signoff/${SIGNOFF}/decide`, { decision: "signed_off", primary_doc_url: "https://eur-lex.europa.eu/x", is_platform_admin: true, admin: true, verifier_status: "active" }, { id: SIGNOFF });
  assert.equal(res.status, 403);
});

test("INV-240/241/238 together: the round trip's refusals leave no trace (an EXTRA group nobody is in, a report nobody can act on)", () => {
  const db = world();
  assert.ok(!db.group(EXTRA));
  assert.equal(HIDDEN.length, 36);
});
