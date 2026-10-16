import assert from "node:assert/strict";
import { test } from "node:test";

import { useWorkspaceStore } from "@/core/workspace/store";
import { PROFILE_TAB_KEYS, resolveInitialProfileTab } from "@/features/account/lib/initial-tab";
import { profilePatchSchema, saveProfilePatch } from "@/features/account/lib/profile-patch";
import { patchWorkspaceSettings } from "@/features/settings";
import { bindSettingsToWorkspace, useSettingsStore } from "@/features/settings/state/settings-store";

import { clientFor, ORG_A, ORG_B, seed, USER } from "./_world.ts";

type SettingsRow = Record<string, unknown> & { alert_config: Record<string, unknown>; home_sections: unknown; default_filters: unknown; profile: unknown; sector_profile: unknown; default_export_format: unknown };
const row = (db: ReturnType<typeof seed>, org = ORG_A) => db.rows("workspace_settings").find((r) => r.org_id === org) as SettingsRow;
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// ── patchWorkspaceSettings (INV-168) ─────────────────────────────────────────────────────────────────

test("INV-168: a patch changes only the caller's keys and never a sibling key", async () => {
  const db = seed();
  const client = clientFor(db);
  const res = await patchWorkspaceSettings(client, ORG_A, "profile", { org_roles: ["forwarder"] });
  assert.deepEqual([res.error, res.value], [null, { roles: ["freight operator"], org_roles: ["forwarder"] }]);
  await patchWorkspaceSettings(client, ORG_A, "alert_config", { briefingCadence: "weekly", briefingDay: "monday" });
  assert.deepEqual(row(db).alert_config, { priorities: ["CRITICAL", "HIGH"], briefingCadence: "weekly", briefingDay: "monday" });
  assert.deepEqual(row(db, ORG_B).alert_config, {}, "another org's row is not touched");
});

test("INV-168: two writers of different keys running at the same moment lose nothing", async () => {
  const db = seed();
  const client = clientFor(db);
  const results = await Promise.all([
    patchWorkspaceSettings(client, ORG_A, "alert_config", { briefingCadence: "weekly" }),
    patchWorkspaceSettings(client, ORG_A, "alert_config", { priorities: ["CRITICAL"] }),
    patchWorkspaceSettings(client, ORG_A, "alert_config", { briefingDay: "friday" }),
    patchWorkspaceSettings(client, ORG_A, "alert_config", { briefingTime: "08:00" }),
  ]);
  assert.deepEqual(results.map((r) => r.error), [null, null, null, null]);
  assert.deepEqual(row(db).alert_config, { priorities: ["CRITICAL"], briefingCadence: "weekly", briefingDay: "friday", briefingTime: "08:00" });
  assert.equal(db.writes("workspace_settings").length, 4, "one database statement per writer: no read-merge-write loop, no retry");
  assert.equal(db.log.filter((l) => l.table === "workspace_settings" && l.op === "select").length, 0, "nothing is read first");
});

test("INV-168: the profile writers of the settings page and the onboarding cannot erase each other either", async () => {
  const db = seed();
  const client = clientFor(db);
  await Promise.all([patchWorkspaceSettings(client, ORG_A, "profile", { org_roles: ["carrier"] }), patchWorkspaceSettings(client, ORG_A, "profile", { org_size: { headcount_band: "small" } })]);
  assert.deepEqual(row(db).profile, { roles: ["freight operator"], org_roles: ["carrier"], org_size: { headcount_band: "small" } });
});

test("sector_profile and default_export_format are replaced by their one writer; every other column is refused", async () => {
  const db = seed();
  const client = clientFor(db);
  assert.equal((await patchWorkspaceSettings(client, ORG_A, "sector_profile", ["fine-art", "pharma"])).error, null);
  assert.deepEqual(row(db).sector_profile, ["fine-art", "pharma"]);
  assert.equal((await patchWorkspaceSettings(client, ORG_A, "default_export_format", "slack")).error, null);
  assert.equal(row(db).default_export_format, "slack");
  assert.match((await patchWorkspaceSettings(client, ORG_A, "org_id" as never, "x")).error ?? "", /not a workspace setting/);
  assert.match((await patchWorkspaceSettings(client, ORG_A, "profile", ["a"])).error ?? "", /object/);
  assert.match((await patchWorkspaceSettings(client, "", "profile", {})).error ?? "", /No workspace/);
  assert.equal(db.writes("workspace_settings").length, 2);
});

test("a failed write, a missing row and a refused write are returned as errors, never reported as saved", async () => {
  const db = seed();
  const client = clientFor(db);
  db.fail("workspace_settings", "update", { message: "write refused" });
  assert.deepEqual(await patchWorkspaceSettings(client, ORG_A, "profile", { a: 1 }), { error: "write refused", value: null });
  assert.equal((await patchWorkspaceSettings(client, ORG_A, "default_export_format", "slack")).error, "write refused");
  db.failures.length = 0;
  assert.match((await patchWorkspaceSettings(client, "33333333-3333-4333-8333-333333333333", "profile", { a: 1 })).error ?? "", /no settings row/);
  assert.match((await patchWorkspaceSettings(client, "33333333-3333-4333-8333-333333333333", "sector_profile", [])).error ?? "", /no settings row/);
  const rpc = { rpc: async () => ({ data: null, error: { message: "permission denied" } }) } as never;
  assert.equal((await patchWorkspaceSettings(rpc, ORG_A, "profile", { a: 1 })).error, "permission denied");
});

// ── the settings store ───────────────────────────────────────────────────────────────────────────────

function fresh() {
  useSettingsStore.setState({ showBandTiles: true, showDueNext: true, showWhatChanged: true, showWatchlistRail: true, showAcrossPlatform: true, showSupersessions: true, defaultSort: "next-date", exportFormat: "html", briefingDay: "monday", alertPriorities: ["CRITICAL", "HIGH"], orgId: null, loaded: false, loadError: null, saveError: null });
  useWorkspaceStore.setState({ orgId: null });
}

test("loadFromWorkspace reads each region under its current key, falls back to the pre-rebuild key, and defaults to visible", async () => {
  fresh();
  const db = seed();
  Object.assign(row(db), { home_sections: { bandTiles: false, dueThisQuarter: false, topUrgency: true, supersessions: false }, default_filters: { defaultSort: "alpha" }, alert_config: { priorities: ["CRITICAL"], briefingDay: "friday" }, default_export_format: "slack" });
  await useSettingsStore.getState().loadFromWorkspace(clientFor(db), ORG_A);
  const s = useSettingsStore.getState();
  assert.deepEqual([s.showBandTiles, s.showDueNext, s.showWhatChanged, s.showWatchlistRail, s.showAcrossPlatform, s.showSupersessions], [false, false, true, true, true, false]);
  assert.deepEqual([s.defaultSort, s.exportFormat, s.alertPriorities, s.briefingDay, s.orgId, s.loaded], ["az", "slack", ["CRITICAL"], "friday", ORG_A, true]);
});

test("every pre-rebuild sort value maps onto the list surfaces' sorts; an unknown value keeps the default", async () => {
  const sorts: [unknown, string][] = [["urgency", "next-date"], ["priority", "next-date"], ["alpha", "az"], ["added", "newest"], ["modified", "newest"], ["newest", "newest"], ["my-order", "my-order"], ["bogus", "next-date"], [undefined, "next-date"]];
  for (const [stored, expected] of sorts) {
    fresh();
    const db = seed();
    row(db).default_filters = { defaultSort: stored };
    await useSettingsStore.getState().loadFromWorkspace(clientFor(db), ORG_A);
    assert.equal(useSettingsStore.getState().defaultSort, expected, String(stored));
  }
});

test("a failed read shows the defaults, records why, and holds saving (orgId unset) so the stored row cannot be overwritten; no row loads the defaults with the org set", async () => {
  fresh();
  const db = seed();
  db.fail("workspace_settings", "select", { message: "read down" });
  await useSettingsStore.getState().loadFromWorkspace(clientFor(db), ORG_A);
  const failed = useSettingsStore.getState();
  assert.deepEqual([failed.orgId, failed.loaded, failed.loadError], [null, true, "read down"]);
  failed.toggleSection("BandTiles");
  await useSettingsStore.getState().flush();
  assert.equal(db.writes("workspace_settings").length, 0);
  assert.equal(useSettingsStore.getState().saveError, null, "nothing was attempted, so nothing failed");
  db.failures.length = 0;
  await useSettingsStore.getState().loadFromWorkspace(clientFor(db), "33333333-3333-4333-8333-333333333333");
  assert.deepEqual([useSettingsStore.getState().orgId, useSettingsStore.getState().loadError], ["33333333-3333-4333-8333-333333333333", null]);
});

test("B-0665 / INV-168: saves go through the key-wise patch: only the changed keys are written, briefing keys from the schedule section survive, and the export format is its own column", async () => {
  fresh();
  const db = seed();
  Object.assign(row(db), { alert_config: { priorities: ["CRITICAL", "HIGH"], briefingCadence: "weekly", briefingTime: "08:00" }, home_sections: { dueNext: true, someOtherKey: 1 } });
  const unbind = bindSettingsToWorkspace(() => clientFor(db));
  useWorkspaceStore.setState({ orgId: ORG_A });
  await settle();
  const s = useSettingsStore.getState();
  assert.equal(s.orgId, ORG_A);
  s.toggleSection("BandTiles");
  s.setBriefingDay("friday");
  s.setAlertPriorities(["CRITICAL"]);
  s.setDefaultSort("newest");
  s.setExportFormat("slack");
  await s.flush();
  unbind();
  assert.deepEqual(row(db).alert_config, { priorities: ["CRITICAL"], briefingCadence: "weekly", briefingTime: "08:00", briefingDay: "friday" });
  assert.deepEqual(row(db).home_sections, { dueNext: true, someOtherKey: 1, bandTiles: false });
  assert.deepEqual(row(db).default_filters, { defaultSort: "newest" });
  assert.equal(row(db).default_export_format, "slack");
  assert.equal(useSettingsStore.getState().saveError, null);
});

test("B-0665: the store is loaded ONCE per org from the workspace store, again only when the org changes, and not at all after unbinding", async () => {
  fresh();
  const db = seed();
  const reads = () => db.log.filter((l) => l.table === "workspace_settings" && l.op === "select").length;
  useWorkspaceStore.setState({ orgId: ORG_A });
  const unbind = bindSettingsToWorkspace(() => clientFor(db));
  await settle();
  assert.deepEqual([reads(), useSettingsStore.getState().orgId], [1, ORG_A]);
  useWorkspaceStore.setState({ orgName: "renamed" });
  useWorkspaceStore.setState({ orgId: ORG_A });
  await settle();
  assert.equal(reads(), 1);
  useWorkspaceStore.setState({ orgId: ORG_B });
  await settle();
  assert.deepEqual([reads(), useSettingsStore.getState().orgId], [2, ORG_B]);
  // A second binding (a remount, a hot reload) for the org that is already loaded reads nothing.
  const again = bindSettingsToWorkspace(() => clientFor(db));
  await settle();
  assert.equal(reads(), 2);
  again();
  unbind();
  useWorkspaceStore.setState({ orgId: ORG_A });
  await settle();
  assert.equal(reads(), 2);
});

test("a failed save is surfaced as saveError and the change stays on screen; the next good save clears it", async () => {
  fresh();
  const db = seed();
  await useSettingsStore.getState().loadFromWorkspace(clientFor(db), ORG_A);
  const unbind = bindSettingsToWorkspace(() => clientFor(db));
  db.fail("workspace_settings", "update", { message: "write refused" });
  useSettingsStore.getState().setAlertPriorities(["LOW"]);
  await useSettingsStore.getState().flush();
  assert.deepEqual([useSettingsStore.getState().saveError, useSettingsStore.getState().alertPriorities], ["write refused", ["LOW"]]);
  db.failures.length = 0;
  useSettingsStore.getState().setAlertPriorities(["HIGH"]);
  await useSettingsStore.getState().flush();
  unbind();
  assert.equal(useSettingsStore.getState().saveError, null);
  assert.deepEqual(row(db).alert_config.priorities, ["HIGH"]);
});

// ── account lib ──────────────────────────────────────────────────────────────────────────────────────

test("initial tab: every real tab key round-trips; missing and unknown fall back to personal; Settings is not a profile tab", () => {
  for (const key of PROFILE_TAB_KEYS) assert.equal(resolveInitialProfileTab(key), key);
  assert.equal(resolveInitialProfileTab(null), "personal");
  assert.equal(resolveInitialProfileTab(undefined), "personal");
  assert.equal(resolveInitialProfileTab("billing"), "personal");
  assert.equal(resolveInitialProfileTab(""), "personal");
  assert.equal((PROFILE_TAB_KEYS as readonly string[]).includes("settings"), false);
});

test("INV-137: a profile patch cannot carry verifier_status, verifier_since or any privilege column; the write is refused before a request is made", async () => {
  const db = seed();
  const client = clientFor(db);
  for (const column of ["verifier_status", "verifier_since", "is_platform_admin", "role", "org_id", "workspace_role", "verification_tier", "membership_tier", "contribution_score", "id", "created_at"]) {
    assert.equal(profilePatchSchema.safeParse({ full_name: "x", [column]: "admin" }).success, false, column);
    const message = await saveProfilePatch(client, USER.member, { [column]: "admin" });
    assert.match(message ?? "", /Invalid profile change/, column);
  }
  assert.equal(db.writes("profiles").length, 0);
});

test("a valid profile patch writes only the caller's own row with the allowed columns", async () => {
  const db = seed();
  const message = await saveProfilePatch(clientFor(db), USER.member, { full_name: "Renamed", jurisdiction_overrides: ["EU"], bio: null });
  assert.equal(message, null);
  const write = db.writes("profiles")[0];
  assert.deepEqual(write?.filters, [["eq", "id", USER.member]]);
  assert.deepEqual(Object.keys(write?.payload as object).sort(), ["bio", "full_name", "jurisdiction_overrides", "updated_at"]);
  db.fail("profiles", "update", { message: "refused by policy" });
  assert.equal(await saveProfilePatch(clientFor(db), USER.member, { bio: "x" }), "refused by policy");
});
