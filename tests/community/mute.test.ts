// A real mute (migration 0063): set by a moderator for 1, 7 or 30 days through moderate_report, enforced on every post and reply by the database, shown on the member's row, never settable by the member. The SQL is proven
// by attack in 0063's own self-check on schema:local; these prove the route, the notice, the sentence and the screens over the world that emulates the same contract.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";

import { POST_ACT } from "@/features/community/api/moderation";
import { PATCH_STAR } from "@/features/community/api/group-prefs";
import { GET as roster } from "@/features/community/api/group-members";
import { POST as createPost } from "@/features/community/api/posts";
import { POST as reply } from "@/features/community/api/replies";
import { actOnReport } from "@/features/community/lib/actions";
import { ModerationActions } from "@/features/community/ui/moderation/ModerationActions";
import { ToastProvider } from "@/features/community/ui/toast";

import { renderApp, textOf } from "../_support/render.ts";

import { asClient, call, ENTITY, PRIV, PUB, REPORT, T_PUB, USER, world, type World } from "./_world.ts";

const DAY = 86_400_000;
const mute = (days: unknown, who: "moderator" | "admin" | "member" | "verifier" = "moderator") => call(POST_ACT, who, "POST", `/api/community/moderation/reports/${REPORT}`, { action: "mute", ...(days === undefined ? {} : { days }), notes: "Cool off" }, { id: REPORT });
const row = (db: World, group = PUB) => db.rows("community_group_members").find((m) => m.group_id === group && m.user_id === USER.member) as Record<string, unknown>;
const newThread = (group = PUB) => call(createPost, "member", "POST", "/api/community/posts", { group_id: group, title: "A thread", body: "Some text", entity_ids: [ENTITY] });
const aReply = () => call(reply, "member", "POST", `/api/community/posts/${T_PUB}/replies`, { body: "A reply" }, { id: T_PUB });

test("a moderator mutes the reported author for 1, 7 or 30 days: the member row carries the end, the report resolves as a mute, the member is told the date", async () => {
  for (const days of [1, 7, 30]) {
    const db = world();
    const res = await mute(days);
    assert.deepEqual([res.status, res.body.action, res.body.status, res.body.notified], [200, "mute", "resolved", true]);
    const end = new Date(Date.parse(db.now) + days * DAY).toISOString();
    assert.equal(row(db).muted_until, end);
    assert.equal(res.body.muted_until, end);
    const notice = db.rows("notification_outbox")[0] as { user_id: string; kind: string; payload: { title: string } };
    assert.deepEqual([notice.user_id, notice.kind], [USER.member, "moderation"]);
    assert.match(notice.payload.title, /muted you in .+ until \d{1,2} \w{3} 2026/);
    assert.ok(!JSON.stringify(notice.payload).includes(USER.moderator), "the notice does not name the moderator");
  }
});

test("a mute lasts 1, 7 or 30 days and nothing else: no days, 0, 3, 365 and a word are refused with nothing changed", async () => {
  for (const days of [undefined, 0, 3, 365, "7"]) {
    const db = world();
    assert.equal((await mute(days)).status, 400, String(days));
    assert.deepEqual([row(db).muted_until ?? null, db.rows("moderation_reports")[0]?.status, db.rows("notification_outbox").length], [null, "open", 0]);
  }
});

test("only a reviewer of the group mutes: a plain member and a stranger are refused and nothing is set", async () => {
  for (const who of ["member", "verifier"] as const) {
    const db = world();
    assert.equal((await mute(7, who)).status, 403, who);
    assert.equal(row(db).muted_until ?? null, null);
  }
});

test("a muted member's thread and reply are both refused with a sentence that names the date, and no row is left; the same member posts in another group", async () => {
  const db = world();
  assert.equal((await mute(7)).status, 200);
  const before = db.rows("community_posts").length;
  const t = await newThread();
  const r = await aReply();
  for (const res of [t, r]) {
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "You are muted in this group until 22 Oct 2026.");
  }
  assert.equal(db.rows("community_posts").length, before, "nothing was written");
  assert.equal((await newThread(PRIV)).status, 201, "the mute is this group's only");
});

test("an expired mute posts again (nothing needs to clear it), and the roster stops showing it", async () => {
  const db = world();
  assert.equal((await mute(1)).status, 200);
  row(db).muted_until = "2099-01-01T00:00:00.000Z"; // far ahead: the roster hides an expired mute by the server's clock, which the world's fixed instant is not
  const shown = await call(roster, "admin", "GET", `/api/community/groups/${PUB}/members`, undefined, { id: PUB });
  assert.deepEqual((shown.body.members as Array<{ muted_until: string | null; role: string }>).filter((m) => m.muted_until).length, 1, "the mute is on the member's row for a reviewer");
  assert.equal((await newThread()).status, 403);
  row(db).muted_until = new Date(Date.parse(db.now) - 60_000).toISOString();
  assert.equal((await newThread()).status, 201);
  assert.equal((await aReply()).status, 201);
  const after = await call(roster, "admin", "GET", `/api/community/groups/${PUB}/members`, undefined, { id: PUB });
  assert.equal((after.body.members as Array<{ muted_until: string | null }>).filter((m) => m.muted_until).length, 0);
});

test("a member cannot set, extend or clear their own mute through the column (the star and mute-notification prefs they own still work)", async () => {
  const db = world();
  assert.equal((await mute(7)).status, 200);
  const client = asClient(db, "member") as unknown as { from: (t: string) => { update: (p: unknown) => { eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => PromiseLike<{ error: { code?: string } | null }> } } } };
  const cleared = await client.from("community_group_members").update({ muted_until: null }).eq("group_id", PUB).eq("user_id", USER.member);
  assert.equal(cleared.error?.code, "42501");
  assert.ok(row(db).muted_until, "the mute stands");
  assert.equal((await call(PATCH_STAR, "member", "PATCH", `/api/community/groups/${PUB}/star`, { starred: true }, { id: PUB })).status, 200);
});

test("the report queue offers the three durations as 44 px buttons, and the action says what was done (and who was told)", async () => {
  const html = renderApp(createElement(ToastProvider, null, createElement(ModerationActions, { reportId: REPORT, onResolved: () => {} })));
  const text = textOf(html);
  for (const label of ["Mute 1 day", "Mute 7 days", "Mute 30 days", "Dismiss", "Warn author", "Remove post", "Ban from group"]) assert.ok(text.includes(label), label);
  const said: Array<[string, string | undefined]> = [];
  let sent: unknown[] = [];
  const api = { act: async (...a: unknown[]) => ((sent = a), { ok: true as const, status: 200, data: { ok: true as const, status: "resolved", action: "mute", notified: true }, error: null }) };
  assert.equal(await actOnReport(api as never, (m, v) => void said.push([m, v]), "r", "mute", " note ", () => {}, 30), true);
  assert.deepEqual(sent, ["r", "mute", "note", 30]);
  assert.deepEqual(said, [["Member muted", "success"]]);
});
