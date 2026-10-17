import assert from "node:assert/strict";
import { test } from "node:test";

import { requestJson, SIGNED_OUT_MESSAGE, UNREACHABLE_MESSAGE } from "@/core/http/request-json";
import { queueNotifications } from "@/core/notifications";
import { ALL_SECTORS, HIGHLIGHTED_SECTOR_IDS, JURISDICTIONS, MODES, REGIONS, regionGroupForLabel } from "@/core/workspace";
import { useWorkspaceStore } from "@/core/workspace/store";
import { DEFAULT_NOTIFICATION_PREFS, readNotificationPrefs, saveNotificationPrefs } from "@/features/account/lib/notification-prefs";
import { saveProfilePatch } from "@/features/account/lib/profile-patch";
import { readSettingsData } from "@/features/settings/server/settings-data";
import { bindSettingsToWorkspace, useSettingsStore } from "@/features/settings/state/settings-store";
import { attributionText, formatAppliedDate } from "@/features/workspace/attribution-text";
import { ARCHIVE_REASONS, reasonLabel } from "@/features/workspace/ui/archive-reasons";
import { clampHighlight, moveHighlight, resolveBackspaceAction, resolveEnterAction, rowCount, showCreateRow, visibleRows } from "@/features/workspace/ui/tag-model";
import { tokenFrom } from "@/features/onboarding/lib/token";

import { fakeDb } from "../_support/fake-db.ts";

import { clientFor, ORG_A, ORG_B, seed } from "./_world.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// ── requestJson: a request never throws, and a refusal carries the server's own words ────────────────────────────────

test("B-0163: requestJson never throws; a refusal carries the server's message, a signed-out answer says so, an unreachable server is a result", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ error: "Workspace archive requires the admin or owner role." }, { status: 403 })) as typeof fetch;
    assert.deepEqual(await requestJson("/x", { method: "POST", body: { a: 1 } }), { ok: false, status: 403, data: { error: "Workspace archive requires the admin or owner role." }, error: "Workspace archive requires the admin or owner role." });
    globalThis.fetch = (async () => Response.json({}, { status: 401 })) as typeof fetch;
    assert.equal((await requestJson("/x")).error, SIGNED_OUT_MESSAGE);
    globalThis.fetch = (async () => new Response("<html>", { status: 502 })) as typeof fetch;
    assert.equal((await requestJson("/x")).error, "The request failed (502).");
    globalThis.fetch = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    assert.deepEqual(await requestJson("/x"), { ok: false, status: 0, data: null, error: UNREACHABLE_MESSAGE });
    globalThis.fetch = (async () => Response.json({ invitations: [] })) as typeof fetch;
    assert.deepEqual(await requestJson("/x"), { ok: true, status: 200, data: { invitations: [] }, error: null });
  } finally {
    globalThis.fetch = real;
  }
});

// ── the tag popover's decisions ──────────────────────────────────────────────────────────────────────────────────────

const TAGS = [
  { id: "t1", name: "Audit 2026", itemCount: 4 },
  { id: "t2", name: "Q4 prep", itemCount: 1 },
];

test("tag popover: search is case-insensitive, the create row shows only without an exact match, and Enter and Backspace act only on a real target", () => {
  assert.deepEqual(visibleRows(TAGS, "  AUD ").map((t) => t.id), ["t1"]);
  assert.equal(showCreateRow(TAGS, "audit 2026"), false, "an exact match, whatever its case, is not created again");
  assert.equal(showCreateRow(TAGS, "audit"), true);
  assert.equal(showCreateRow(TAGS, "   "), false);
  assert.equal(rowCount(TAGS, "audit"), 2);
  assert.deepEqual(resolveEnterAction(TAGS, "", -1), { type: "none" }, "Enter never applies a random row");
  assert.deepEqual(resolveEnterAction(TAGS, "", 1), { type: "toggle", tagId: "t2" });
  assert.deepEqual(resolveEnterAction(TAGS, "new one", 0), { type: "create", name: "new one" });
  assert.deepEqual(resolveEnterAction(TAGS, "audit", 1), { type: "create", name: "audit" });
  assert.deepEqual(resolveBackspaceAction("", ["t1", "t2"]), { type: "removeLast", tagId: "t2" });
  assert.deepEqual(resolveBackspaceAction("a", ["t1"]), { type: "none" });
  assert.deepEqual(resolveBackspaceAction("", []), { type: "none" });
  assert.deepEqual([moveHighlight(-1, 1, 3), moveHighlight(-1, -1, 3), moveHighlight(2, 1, 3), moveHighlight(0, -1, 3), moveHighlight(0, 1, 0)], [0, 2, 0, 2, -1]);
  assert.deepEqual([clampHighlight(5, 3), clampHighlight(-1, 3), clampHighlight(2, 0)], [2, -1, -1]);
});

test("tag attribution: the wording the chip title and the popover share; a removed account and a nameless member read plainly", () => {
  assert.equal(formatAppliedDate("2026-09-03T23:59:00Z"), "3 Sep 2026");
  assert.equal(formatAppliedDate("not a date"), null);
  assert.equal(attributionText({ tagId: "t", appliedBy: "u", appliedByName: "Pat Lee", appliedAt: "2026-09-03T00:00:00Z" }), "applied by Pat Lee on 3 Sep 2026");
  assert.equal(attributionText({ tagId: "t", appliedBy: "u", appliedByName: null, appliedAt: null }), "applied by a workspace member");
  assert.equal(attributionText({ tagId: "t", appliedBy: null, appliedByName: null, appliedAt: "2026-09-03T00:00:00Z" }), "applied by a former member on 3 Sep 2026");
  assert.equal(attributionText(undefined), null);
});

// ── vocabularies ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("the workspace vocabularies are data, complete and unique; the six niches are one flag; a label's region group is never guessed", () => {
  assert.deepEqual([ALL_SECTORS.length, JURISDICTIONS.length, MODES.length, REGIONS.length], [40, 84, 4, 8]);
  assert.deepEqual([...HIGHLIGHTED_SECTOR_IDS].sort(), ["automotive", "film-tv", "fine-art", "humanitarian", "live-events", "luxury-goods"]);
  assert.equal(regionGroupForLabel("Singapore"), "Asia-Pacific");
  assert.equal(regionGroupForLabel("Atlantis"), "");
  assert.equal(reasonLabel("not_applicable"), "Not applicable to us");
  assert.equal(reasonLabel("custom-reason"), "custom-reason", "a reason the vocabulary no longer holds shows as itself, never dropped");
  assert.equal(reasonLabel(null), null);
  assert.ok(ARCHIVE_REASONS.length >= 5);
});

test("a pasted invitation link or bare token yields the 64-hex token; text without one yields none", () => {
  const token = "ab12".repeat(16);
  assert.equal(tokenFrom(`https://app.example.test/invitations/${token}`), token);
  assert.equal(tokenFrom(`  ${token.toUpperCase()} `), token);
  assert.equal(tokenFrom("https://app.example.test/invitations/short"), null);
  assert.equal(tokenFrom(""), null);
});

// ── notification preferences ─────────────────────────────────────────────────────────────────────────────────────────

test("notification preferences: a missing row is the defaults, a failed read is an error (never saved settings), the seed leaves an existing row alone, a refused save returns its reason", async () => {
  const none = fakeDb(() => ({ data: null }));
  assert.deepEqual(await readNotificationPrefs(none.db, "u1"), { prefs: { ...DEFAULT_NOTIFICATION_PREFS }, error: null });
  const down = fakeDb(() => ({ error: { message: "read down" } }));
  assert.equal((await readNotificationPrefs(down.db, "u1")).error, "read down");
  const stored = fakeDb(() => ({ data: { enabled: false, on_mention: false } }));
  const read = await readNotificationPrefs(stored.db, "u1");
  assert.deepEqual([read.prefs.enabled, read.prefs.on_mention, read.prefs.on_new_post_in_joined_groups, read.prefs.on_invite], [false, false, false, true]);

  const ok = fakeDb(() => undefined);
  assert.equal(await saveNotificationPrefs(ok.db, "u1", { ...DEFAULT_NOTIFICATION_PREFS }, { seed: true, now: () => "2026-10-16T00:00:00.000Z" }), null);
  const refused = fakeDb(() => ({ error: { message: "permission denied" } }));
  assert.equal(await saveNotificationPrefs(refused.db, "u1", { ...DEFAULT_NOTIFICATION_PREFS, enabled: false }), "permission denied");
});

test("INV-137: the personal profile and the onboarding writers can set only their own columns; job_title is allowed, a privilege column is refused before a request", async () => {
  const sink = fakeDb(() => undefined);
  assert.equal(await saveProfilePatch(sink.db, "u1", { job_title: "Head of operations", transport_mode_overrides: ["air"], jurisdiction_overrides: ["us"] }), null);
  assert.equal(sink.calls.length, 1);
  for (const forbidden of [{ is_platform_admin: true }, { verifier_status: "active" }, { org_id: "x" }]) assert.match((await saveProfilePatch(sink.db, "u1", forbidden)) ?? "", /Invalid profile change/);
  assert.equal(sink.calls.length, 1, "a refused patch makes no request");
});

// ── the settings store's one writer (INV-168, B-0665, B-0186) ────────────────────────────────────────────────────────

test("INV-168: the sectors card and the organisation profile are two writers of different columns, even at the same moment, and lose nothing; the schedule keeps its siblings", async () => {
  const db = seed();
  useWorkspaceStore.setState({ orgId: ORG_A });
  const unbind = bindSettingsToWorkspace(() => clientFor(db));
  await settle();
  const s = useSettingsStore.getState();
  assert.equal(s.orgId, ORG_A);
  const results = await Promise.all([s.commit("sector_profile", ["fine-art", "pharma"]), s.commit("profile", { org_roles: ["carrier"], org_size: { headcount_band: "small" } }), s.commit("alert_config", { briefingCadence: "daily" })]);
  unbind();
  assert.deepEqual(results, [null, null, null]);
  const row = db.rows("workspace_settings").find((r) => r.org_id === ORG_A) as Record<string, unknown>;
  assert.deepEqual(row.sector_profile, ["fine-art", "pharma"]);
  assert.deepEqual(row.profile, { roles: ["freight operator"], org_roles: ["carrier"], org_size: { headcount_band: "small" } });
  assert.deepEqual(row.alert_config, { priorities: ["CRITICAL", "HIGH"], briefingCadence: "daily" });
  const after = useSettingsStore.getState();
  assert.deepEqual([after.sectorProfile, after.alertConfig.briefingCadence, (after.profile as Record<string, unknown>).org_roles], [["fine-art", "pharma"], "daily", ["carrier"]]);
  assert.deepEqual(useWorkspaceStore.getState().sectorProfile, ["fine-art", "pharma"], "the rest of the app follows the saved sectors");
});

test("B-0186: a refused write is returned and the screen's copy is untouched; a write before the settings loaded is refused, never sent", async () => {
  const db = seed();
  useWorkspaceStore.setState({ orgId: ORG_B });
  useSettingsStore.setState({ orgId: null, loaded: false, alertConfig: {}, profile: {}, sectorProfile: ["kept"] });
  assert.match((await useSettingsStore.getState().commit("profile", { a: 1 })) ?? "", /have not loaded/);
  assert.equal(db.writes("workspace_settings").length, 0);
  const unbind = bindSettingsToWorkspace(() => clientFor(db));
  await settle();
  db.fail("workspace_settings", "update", { message: "write refused" });
  assert.equal(await useSettingsStore.getState().commit("sector_profile", ["x"]), "write refused");
  assert.deepEqual(useSettingsStore.getState().sectorProfile, [], "the copy follows the database, not the attempt");
  unbind();
});

// ── the notification outbox (IMP-025) ────────────────────────────────────────────────────────────────────────────────

test("IMP-025: notices are queued in ONE insert for every recipient; an empty batch writes nothing; a refusal is returned, never thrown", async () => {
  const db = fakeDb(() => undefined);
  assert.equal(await queueNotifications([], db.db), null);
  assert.equal(db.calls.length, 0);
  const rows = [
    { userId: "u1", kind: "archive" as const, payload: { title: "a" } },
    { userId: "u2", kind: "archive" as const, payload: { title: "a" } },
  ];
  assert.equal(await queueNotifications(rows, db.db), null);
  assert.equal(db.calls.length, 1);
  assert.deepEqual((db.calls[0]?.payload as { user_id: string }[]).map((r) => r.user_id), ["u1", "u2"]);
  assert.equal(db.calls[0]?.table, "notification_outbox");
  assert.equal(await queueNotifications(rows, fakeDb(() => ({ error: { message: "outbox down" } })).db), "outbox down");
});

// ── the settings page's reads: a failed read is its own message, never an empty list ─────────────────────────────────

const item = (id: string, title: string) => ({ id, legacy_id: null, title, item_type: "regulation", domain: 1 });

test("IMP-066, INV-263: the settings page reads ONE bundle (a quarter of the old four requests); a team archive hides the personal row; the replacement comes from the bundle; a failed or absent bundle fails both sections with its reason", async () => {
  const bundle = {
    overrides: [{ item_id: "i1", archive_reason: "superseded", archive_note: null, archived_at: "2026-09-01T00:00:00Z", item: item("i1", "FuelEU Maritime") }],
    personal: [{ item_id: "i1", archive_note: "mine", archived_at: "2026-09-02T00:00:00Z", item: item("i1", "FuelEU Maritime") }, { item_id: "i2", archive_note: "n", archived_at: "2026-09-03T00:00:00Z", item: item("i2", "Old port rule") }],
    supersessions: [{ id: "s1", supersession_date: "2026-08-01", severity: "major", note: "n", old: item("i1", "A"), new: item("i9", "B") }],
    history: [{ old_item_id: "i1", new: item("i9", "FuelEU Maritime 2027") }],
    truncated: { overrides: false, personal: false, supersessions: true },
  };
  const ok = fakeDb(() => undefined, { rpc: (name) => (name === "load_settings_bundle" ? { data: bundle } : undefined) });
  const data = await readSettingsData(ok.db, { orgId: ORG_A, userId: "u1" });
  assert.deepEqual([ok.calls.length, ok.rpcs.length, ok.rpcs[0]?.args], [0, 1, { p_org_id: ORG_A, p_user_id: "u1", p_limit: 200 }], "one request, no table read");
  assert.equal(data.archive.error, null);
  const rows = data.archive.rows ?? [];
  assert.deepEqual(rows.map((r) => [r.title, r.scope]), [["FuelEU Maritime", "team"], ["Old port rule", "personal"]]);
  assert.equal(rows[0]?.replacement?.title, "FuelEU Maritime 2027");
  assert.equal(rows[1]?.replacement, null);
  assert.deepEqual([data.supersessions.rows?.[0]?.old.title, data.supersessions.truncated, data.archive.truncated], ["A", true, false]);

  for (const [what, error, expected] of [["a failed bundle", { message: "read down" }, /read down/], ["an absent function (production before the cutover)", { message: "not found", code: "PGRST202" }, /database update \(0038\)/], ["a missing function", { message: "x", code: "42883" }, /0038/]] as const) {
    const broken = await readSettingsData(fakeDb(() => undefined, { rpc: () => ({ error }) }).db, { orgId: ORG_A, userId: "u1" });
    assert.deepEqual([broken.archive.rows, broken.supersessions.rows], [null, null], what);
    assert.match(broken.archive.error ?? "", expected, what);
    assert.match(broken.supersessions.error ?? "", expected, what);
  }
  const empty = await readSettingsData(fakeDb(() => undefined, { rpc: () => ({ data: null }) }).db, { orgId: null, userId: "u1" });
  assert.match(empty.archive.error ?? "", /empty/, "no data and no error is a failure, never an empty list");
});
