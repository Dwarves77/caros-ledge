// INV-242 and the notification path: route -> queueNotifications -> allowedRecipients -> outbox -> drain -> notifications row -> the shell's unread store. A notification is read and marked only by its recipient; a
// failure of the notification never aborts the action that caused it; an invitation cannot be disabled; a muted group, a disabled kind and a disabled master switch are honoured; a mute that did nothing is the defect.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { allowedRecipients, dispatchNotification, queueNotifications } from "@/core/notifications";
import { runNotificationOutbox } from "@/features/drain/kinds";
import { markAllRead, markRead, appendOlder, safeLink, titleOf, emptyInbox, type InboxItem } from "@/ui/shell/notifications/inbox-model";
import { POST_INVITE } from "@/features/community/api/group-invitations";
import { PATCH_MUTE } from "@/features/community/api/group-prefs";
import { POST_ACT } from "@/features/community/api/moderation";
import { GET as list, GET_COUNTS, POST as markAll, POST_ONE } from "@/features/community/api/notifications";
import { POST as reply } from "@/features/community/api/replies";

import { call, PUB, REPORT, serviceOf, STRANGER, T_PUB, USER, world, type Viewer, type World } from "./_world.ts";

const NOW = () => new Date("2026-10-17T09:00:00.000Z");
const rows = (db: World, table: string) => db.rows(table);
const note = (db: World, userId: string, kind: "reply" | "invite" | "moderation" | "mention", extra: Record<string, unknown> = {}) => ({ userId, kind, payload: { title: "t", body: "b", link: "/community", ...extra } });
const prefs = (db: World, userId: string, over: Record<string, unknown>) => db.rows("notification_preferences").push({ user_id: userId, enabled: true, on_mention: true, on_reply_in_my_threads: true, on_new_post_in_joined_groups: false, on_invite: true, on_promote: true, channels: {}, updated_at: db.now, ...over });
const mute = (db: World, groupId: string, userId: string, muted = true) => void (db.rows("community_group_members").find((m) => m.group_id === groupId && m.user_id === userId)!.muted = muted);

test("INV-242: allowedRecipients drops a disabled master switch, a disabled kind and a muted group; an invitation is never dropped; a kind with no switch answers to the master switch", async () => {
  const db = world();
  const svc = serviceOf(db);
  prefs(db, USER.member, { enabled: false });
  prefs(db, USER.moderator, { on_reply_in_my_threads: false });
  mute(db, PUB, USER.admin);
  const batch = [
    note(db, USER.member, "reply"), // master switch off
    note(db, USER.member, "invite"), // never dropped
    note(db, USER.member, "moderation"), // no per-kind switch: the master switch applies
    note(db, USER.moderator, "reply"), // the reply switch is off
    note(db, USER.moderator, "mention"), // the mention switch is on
    note(db, USER.moderator, "moderation"), // no switch: delivered
    note(db, USER.admin, "reply", { group_id: PUB }), // muted group
    note(db, USER.admin, "reply", { group_id: "cccccccc-0000-4000-8000-000000000002" }), // a different group, not muted
    note(db, USER.admin, "invite", { group_id: PUB }), // muted, but an invitation
    note(db, USER.verifier, "reply"), // no preferences row: the defaults deliver
  ];
  const kept = await allowedRecipients(svc, batch);
  assert.deepEqual(kept.map((n) => [n.userId === USER.member ? "member" : n.userId === USER.moderator ? "moderator" : n.userId === USER.admin ? "admin" : "verifier", n.kind]), [["member", "invite"], ["moderator", "mention"], ["moderator", "moderation"], ["admin", "reply"], ["admin", "invite"], ["verifier", "reply"]]);
  assert.equal((await allowedRecipients(svc, [])).length, 0);
});

test("INV-242: a preference or mute read that fails THROWS, so nothing is sent past a setting that could not be checked; dispatch turns it into its returned failure and inserts nothing", async () => {
  const db = world();
  db.fail("notification_preferences", "select", "prefs down");
  await assert.rejects(allowedRecipients(serviceOf(db), [note(db, USER.member, "reply")]), /prefs down/);
  const out = await dispatchNotification({ userId: USER.member, kind: "reply", payload: {} }, serviceOf(db));
  assert.match(String(out), /prefs down/);
  assert.equal(rows(db, "notifications").length, 0);
  const db2 = world();
  db2.fail("community_group_members", "select", "mutes down");
  await assert.rejects(allowedRecipients(serviceOf(db2), [note(db2, USER.member, "reply", { group_id: PUB })]), /mutes down/);
});

test("INV-242: a dropped notification is a success (nothing was owed) and an invitation is delivered whatever the recipient set", async () => {
  const db = world();
  prefs(db, USER.member, { enabled: false });
  assert.equal(await dispatchNotification({ userId: USER.member, kind: "reply", payload: {} }, serviceOf(db)), null);
  assert.equal(rows(db, "notifications").length, 0);
  assert.equal(await dispatchNotification({ userId: USER.member, kind: "invite", payload: { title: "Invitation" } }, serviceOf(db)), null);
  assert.equal(rows(db, "notifications").length, 1);
});

test("a mute that does something: PATCH mute sets the member's flag, and the next reply notification for that group is dropped on its way to the notifications table (the defect was a mute that did nothing)", async () => {
  const db = world();
  // a reply by the moderator to the member's thread notifies the member
  assert.equal((await call(reply, "moderator", "POST", `/api/community/posts/${T_PUB}/replies`, { body: "First" }, { id: T_PUB })).status, 201);
  await runNotificationOutbox({ sb: serviceOf(db), now: NOW }, { dry: false });
  assert.equal(rows(db, "notifications").filter((n) => n.user_id === USER.member).length, 1, "before the mute, the notification arrives");
  assert.equal((await call(PATCH_MUTE, "member", "PATCH", `/api/community/groups/${PUB}/mute`, { muted: true }, { id: PUB })).status, 200);
  assert.equal(db.role(PUB, USER.member), "member");
  assert.equal(db.rows("community_group_members").find((m) => m.group_id === PUB && m.user_id === USER.member)?.muted, true, "the flag is stored");
  assert.equal((await call(reply, "moderator", "POST", `/api/community/posts/${T_PUB}/replies`, { body: "Second" }, { id: T_PUB })).status, 201);
  await runNotificationOutbox({ sb: serviceOf(db), now: NOW }, { dry: false });
  assert.equal(rows(db, "notifications").filter((n) => n.user_id === USER.member).length, 1, "after the mute, no second notification is delivered");
  assert.ok(rows(db, "notification_outbox").every((o) => o.status === "sent"), "the outbox row is closed, not retried forever");
  assert.equal((await call(PATCH_MUTE, "member", "PATCH", `/api/community/groups/${PUB}/mute`, { muted: false }, { id: PUB })).status, 200);
  assert.equal((await call(reply, "moderator", "POST", `/api/community/posts/${T_PUB}/replies`, { body: "Third" }, { id: T_PUB })).status, 201);
  await runNotificationOutbox({ sb: serviceOf(db), now: NOW }, { dry: false });
  assert.equal(rows(db, "notifications").filter((n) => n.user_id === USER.member).length, 2, "unmuted, they arrive again");
});

const UNREAD_URL = "/api/community/notifications?unread_only=true&limit=1";

test("the notification path end to end: route -> outbox -> drain -> notifications row -> the shell's unread store reads it, the recipient marks it read, nobody else can", async () => {
  const db = world();
  const res = await call(reply, "moderator", "POST", `/api/community/posts/${T_PUB}/replies`, { body: "A long enough reply to be quoted" }, { id: T_PUB });
  assert.deepEqual([res.status, res.body.notified], [201, true]);
  const queued = rows(db, "notification_outbox");
  assert.equal(queued.length, 1);
  assert.deepEqual([queued[0]?.user_id, queued[0]?.kind, queued[0]?.status], [USER.member, "reply", "pending"]);
  const payload = queued[0]?.payload as Record<string, unknown>;
  assert.ok(!JSON.stringify(payload).includes(USER.moderator), "the payload names no reply author: an anonymous replier is not linkable");
  assert.equal(payload.link, "/community/grp-fine-art-room");
  const drained = await runNotificationOutbox({ sb: serviceOf(db), now: NOW }, { dry: false });
  assert.deepEqual([drained.counts?.sent, drained.counts?.gave_up], [1, 0]);
  assert.equal(rows(db, "notifications").length, 1);
  // The shell's store polls the unread count through the member's own route: the number is the server's, and signed out is unknown, not zero.
  const unread = async (who: Viewer): Promise<number | null> => {
    const r = await call(list, who, "GET", UNREAD_URL);
    const n = (r.body as { unread_count?: unknown }).unread_count;
    return r.status === 200 && typeof n === "number" ? n : null;
  };
  assert.equal(await unread("member"), 1);
  assert.equal(await unread("moderator"), 0, "another user's inbox is theirs alone");
  assert.equal(await unread("anon"), null, "signed out is unknown, not zero");
  assert.ok(readFileSync("src/ui/shell/use-unread-count.ts", "utf8").includes(UNREAD_URL), "the shell polls exactly the route and query the Community inbox serves");
  const id = rows(db, "notifications")[0]?.id as string;
  assert.equal((await call(POST_ONE, "moderator", "POST", `/api/community/notifications/${id}`, { action: "mark_read" }, { id })).status, 404, "not the recipient: not found, unchanged");
  assert.equal(rows(db, "notifications")[0]?.read_at ?? null, null);
  assert.equal((await call(POST_ONE, "member", "POST", `/api/community/notifications/${id}`, { action: "mark_read" }, { id })).status, 200);
  assert.equal(await unread("member"), 0);
  const counts = await call(GET_COUNTS, "member", "GET", "/api/community/notifications/counts");
  assert.deepEqual(counts.body, { groups: [], total_unread: 0 });
});

test("INV-242: the list is the caller's own; mark-all marks only theirs; the unread count is the server's number, not the page's length", async () => {
  const db = world();
  for (let i = 0; i < 5; i += 1) db.rows("notifications").push({ id: `eeeeeeee-0000-4000-8000-0000000001${i}0`, user_id: USER.member, kind: "reply", payload: { title: `n${i}`, group_id: PUB }, read_at: null, created_at: `2026-10-1${i}T00:00:00Z` });
  db.rows("notifications").push({ id: "eeeeeeee-0000-4000-8000-000000000199", user_id: USER.admin, kind: "reply", payload: {}, read_at: null, created_at: "2026-10-16T00:00:00Z" });
  const page = await call(list, "member", "GET", "/api/community/notifications?limit=2");
  assert.deepEqual([(page.body.notifications as unknown[]).length, page.body.unread_count, page.body.total_matching, typeof page.body.next_cursor], [2, 5, 5, "string"]);
  const unreadOnly = await call(list, "member", "GET", "/api/community/notifications?unread_only=true&limit=1");
  assert.equal(unreadOnly.body.unread_count, 5, "the shell's poll gets the full count from a page of one");
  const counts = await call(GET_COUNTS, "member", "GET", "/api/community/notifications/counts");
  assert.deepEqual(counts.body, { groups: [{ group_id: PUB, unread_count: 5 }], total_unread: 5 });
  assert.deepEqual((await call(markAll, "member", "POST", "/api/community/notifications", { action: "mark_all_read" })).body, { ok: true, updated: 5 });
  assert.equal(rows(db, "notifications").find((n) => n.user_id === USER.admin)?.read_at ?? null, null, "someone else's notification is untouched");
  db.fail("notifications", "select", "down");
  assert.equal((await call(list, "member", "GET", "/api/community/notifications")).status, 503, "a failed count is a 503, never a zero");
});

test("INV-242: a failed notification never aborts the action that caused it: the reply, the invitation and the moderation action all succeed and say so", async () => {
  const db = world();
  db.fail("notification_outbox", "insert", "outbox down");
  const r = await call(reply, "moderator", "POST", `/api/community/posts/${T_PUB}/replies`, { body: "Still posted" }, { id: T_PUB });
  assert.deepEqual([r.status, r.body.notified], [201, false]);
  assert.ok(db.post((r.body.reply as { id: string }).id));
  const i = await call(POST_INVITE, "admin", "POST", `/api/community/groups/${PUB}/invite`, { invitee_user_id: STRANGER }, { id: PUB });
  assert.deepEqual([i.status, i.body.notified], [200, false]);
  assert.equal(db.rows("community_group_invitations").some((x) => x.invitee_user_id === STRANGER && x.status === "pending"), true, "the invitation stands");
  const m = await call(POST_ACT, "moderator", "POST", `/api/community/moderation/reports/${REPORT}`, { action: "warn" }, { id: REPORT });
  assert.deepEqual([m.status, m.body.notified, m.body.status], [200, false, "resolved"]);
});

// ── the inbox's pure state (the count is rolled back with its items) ────────────────────────────────────────────────

const item = (id: string, read: string | null = null, payload: InboxItem["payload"] = { title: id }): InboxItem => ({ id, kind: "reply", payload, read_at: read, created_at: "2026-10-16T00:00:00Z" });

test("the inbox: marking one or all read changes the items AND the count together, and putting the earlier state back restores both", () => {
  const before = { items: [item("a"), item("b"), item("c", "2026-10-15T00:00:00Z")], unread: 7, next: "cursor" };
  const one = markRead(before, "a", "now");
  assert.deepEqual([one.items.map((n) => n.read_at), one.unread], [["now", null, "2026-10-15T00:00:00Z"], 6]);
  assert.equal(markRead(one, "a", "later"), one, "an already-read item changes nothing");
  assert.equal(markRead(before, "zzz", "now"), before, "an item not on screen changes nothing");
  assert.equal(markRead(before, "c", "now"), before);
  const all = markAllRead(before, "now");
  assert.deepEqual([all.items.every((n) => n.read_at), all.unread], [true, 0]);
  assert.deepEqual(all.items.find((n) => n.id === "c")?.read_at, "2026-10-15T00:00:00Z", "an earlier read time is kept");
  assert.deepEqual(before.items.map((n) => n.read_at), [null, null, "2026-10-15T00:00:00Z"], "the state is never mutated, so the earlier one IS the rollback");
});

test("the inbox: an older page is appended without repeating an item, the cursor moves; a title is never a raw id; only an in-app link is followed", () => {
  const s = appendOlder({ ...emptyInbox, items: [item("a")], next: "c1" }, { notifications: [item("a"), item("b")], next_cursor: null });
  assert.deepEqual([s.items.map((n) => n.id), s.next], [["a", "b"], null]);
  assert.equal(titleOf(item("x", null, {})), "Reply");
  assert.equal(titleOf({ ...item("x", null, {}), kind: "unheard-of" }), "Notification");
  assert.equal(titleOf(item("x", null, { title: "Real title" })), "Real title");
  assert.deepEqual(["/community", "//evil.example", "https://evil.example", "javascript:alert(1)", undefined].map(safeLink), ["/community", null, null, null, null]);
});

test("a count that cannot be read is a 503 even when the page read succeeded: the unread total is its own read, and a failure of it is never a zero or the page's length", async () => {
  const db = world();
  db.rows("notifications").push({ id: "eeeeeeee-0000-4000-8000-000000000301", user_id: USER.member, kind: "reply", payload: {}, read_at: null, created_at: "2026-10-16T00:00:00Z" });
  let n = 0;
  db.fail("notifications", "select", "count down", { when: () => (n += 1) === 2 });
  const res = await call(list, "member", "GET", "/api/community/notifications?limit=5");
  assert.equal(res.status, 503);
});

test("queue time: a muted group or a disabled kind is dropped BEFORE the outbox row exists (queueNotifications asks allowedRecipients), an invitation never is, and a preference read that fails fails the queue", async () => {
  const db = world();
  mute(db, PUB, USER.member);
  assert.deepEqual(await queueNotifications([note(db, USER.member, "reply", { group_id: PUB })], serviceOf(db)), null, "a drop is a success: nothing was owed");
  assert.equal(rows(db, "notification_outbox").length, 0, "no outbox row for a muted group");
  prefs(db, USER.moderator, { on_reply_in_my_threads: false });
  await queueNotifications([note(db, USER.moderator, "reply"), note(db, USER.admin, "reply")], serviceOf(db));
  assert.deepEqual(rows(db, "notification_outbox").map((o) => o.user_id), [USER.admin], "only the recipient whose kind is on is queued");
  await queueNotifications([note(db, USER.member, "invite", { group_id: PUB })], serviceOf(db));
  assert.equal(rows(db, "notification_outbox").filter((o) => o.kind === "invite").length, 1, "an invitation to a muted group is still queued");
  db.fail("notification_preferences", "select", "prefs down");
  assert.match(String(await queueNotifications([note(db, USER.verifier, "reply")], serviceOf(db))), /prefs down/);
  assert.equal(rows(db, "notification_outbox").length, 2, "nothing was queued past a setting that could not be checked");
  // the route: a reply to a muted author queues nothing
  const w = world();
  mute(w, PUB, USER.member);
  assert.equal((await call(reply, "moderator", "POST", `/api/community/posts/${T_PUB}/replies`, { body: "Muted" }, { id: T_PUB })).status, 201);
  assert.equal(rows(w, "notification_outbox").length, 0);
});
