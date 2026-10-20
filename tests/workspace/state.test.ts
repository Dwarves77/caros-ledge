import assert from "node:assert/strict";
import { test } from "node:test";

import type { Resource } from "@/core/types";
import { applyWorkspaceSeed, useWorkspaceStore } from "@/core/workspace/store";
import { mergeWithOverrides, useItemStateStore } from "@/features/workspace/state";
import type { PersonalItemState, WorkspaceOverride } from "@/features/workspace/state";

const resource = (id: string, over: Partial<Resource> = {}): Resource => ({ id, cat: "ocean", sub: "", title: id, url: "", note: "", type: "regulation", priority: "MODERATE", added: "2026-01-01", reasoning: "", tags: [], whatIsIt: "", whyMatters: "", keyData: [], ...over });
const ovr = (itemId: string, over: Partial<WorkspaceOverride> = {}): WorkspaceOverride => ({ itemId, priorityOverride: null, isArchived: false, archiveReason: null, archiveNote: null, ...over });
const personal = (itemId: string, over: Partial<PersonalItemState> = {}): PersonalItemState => ({ itemId, isArchived: true, archiveNote: null, archivedAt: "2026-02-03T10:00:00Z", ...over });

// ── merge ────────────────────────────────────────────────────────────────────────────────────────────

test("merge: platform, then the org override, then personal state; each item lands in exactly one bucket", () => {
  const resources = ["a", "b", "c", "d", "e"].map((id) => resource(id));
  const overrides = new Map([ovr("b", { priorityOverride: "CRITICAL" }), ovr("c", { isArchived: true, archiveReason: "dup", archiveNote: "n", archivedAt: "2026-03-04T09:00:00Z" }), ovr("d", { dismissedAt: "2026-04-01T00:00:00Z", priorityOverride: "HIGH" })].map((o) => [o.itemId, o] as const));
  const out = mergeWithOverrides(resources, overrides, new Map([["e", personal("e")]]));
  assert.deepEqual(out.active.map((r) => [r.id, r.priority]), [["a", "MODERATE"], ["b", "CRITICAL"]]);
  assert.deepEqual(out.dismissed.map((r) => [r.id, r.priority]), [["d", "HIGH"]]);
  assert.deepEqual(out.archived.map((r) => r.id), ["c", "e"]);
});

test("merge: a personal archive wins over every wider scope, and restoring for the team does not un-hide it for that user", () => {
  const out = mergeWithOverrides([resource("a")], new Map([["a", ovr("a", { isArchived: false })]]), new Map([["a", personal("a", { archiveNote: "mine" })]]));
  assert.deepEqual(out.archived.map((r) => [r.archiveReason, r.archiveNote, r.archivedDate]), [["personal", "mine", "2026-02-03"]]);
  const both = mergeWithOverrides([resource("a")], new Map([["a", ovr("a", { isArchived: true, archiveReason: "team" })]]), new Map([["a", personal("a")]]));
  assert.equal(both.archived[0]?.archiveReason, "personal");
  assert.equal(mergeWithOverrides([resource("a")], new Map(), new Map([["a", personal("a", { isArchived: false })]])).active.length, 1);
});

test("merge: the date shown for a team archive is the STORED archived_at, never the render date; none stored means none shown", () => {
  const stored = mergeWithOverrides([resource("a")], new Map([["a", ovr("a", { isArchived: true, archivedAt: "2026-03-04T23:59:00Z" })]]));
  assert.equal(stored.archived[0]?.archivedDate, "2026-03-04");
  const none = mergeWithOverrides([resource("a")], new Map([["a", ovr("a", { isArchived: true })]]));
  assert.equal(none.archived[0]?.archivedDate, undefined);
});

test("merge: the org owner surfaces through actionOwner; a departed owner leaves the platform's suggestion alone", () => {
  const out = mergeWithOverrides([resource("a", { actionOwner: "Legal" }), resource("b", { actionOwner: "Legal" })], new Map([["a", ovr("a", { ownerUserId: "u", ownerName: "Ada" })], ["b", ovr("b", { ownerUserId: "gone", ownerName: null })]]));
  assert.deepEqual(out.active.map((r) => r.actionOwner), ["Ada", "Legal"]);
});

// ── the item-state store ─────────────────────────────────────────────────────────────────────────────

interface Sent {
  path: string;
  method: string;
  body: Record<string, unknown>;
}
function transport(reply: (sent: Sent) => Response | Promise<Response> | Error, signedIn = true) {
  const sent: Sent[] = [];
  useItemStateStore.getState().setTransport({
    client: { auth: { getSession: async () => ({ data: { session: signedIn ? { access_token: "tok" } : null } }) } },
    fetchImpl: async (input, init) => {
      const record = { path: String(input), method: String(init?.method), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      sent.push(record);
      const r = await reply(record);
      if (r instanceof Error) throw r;
      return r;
    },
  });
  return sent;
}
const ok = () => new Response("{}", { status: 200 });
const refuse = (status: number, error: string) => new Response(JSON.stringify({ error }), { status });
const reset = () => useItemStateStore.setState({ overrides: new Map(), personalState: new Map() });
const state = () => useItemStateStore.getState();

test("a write is applied at once, persisted with exactly the changed fields, and resolves null on success", async () => {
  reset();
  const sent = transport(ok);
  const pending = state().updatePriority("o3", "HIGH");
  assert.equal(state().overrides.get("o3")?.priorityOverride, "HIGH");
  assert.equal(await pending, null);
  assert.deepEqual(sent, [{ path: "/api/workspace/overrides", method: "POST", body: { itemId: "o3", priorityOverride: "HIGH", dismissedAt: null } }]);
});

test("a refused workspace archive is rolled back and the server's own wording is returned verbatim", async () => {
  reset();
  state().setOverrides([ovr("o3", { priorityOverride: "LOW" })]);
  transport(() => refuse(403, "Workspace archive requires the admin or owner role. You can archive it just for yourself instead."));
  const error = await state().archiveResource("o3", "stale", "note");
  assert.equal(error, "Workspace archive requires the admin or owner role. You can archive it just for yourself instead.");
  assert.deepEqual([state().overrides.get("o3")?.isArchived, state().overrides.get("o3")?.priorityOverride], [false, "LOW"]);
});

test("a successful archive keeps the optimistic row with a date; restore clears the archive fields and the date", async () => {
  reset();
  const sent = transport(ok);
  assert.equal(await state().archiveResource("o3", "stale", "n"), null);
  assert.deepEqual([state().overrides.get("o3")?.isArchived, state().overrides.get("o3")?.archiveReason, typeof state().overrides.get("o3")?.archivedAt], [true, "stale", "string"]);
  assert.deepEqual(sent[0]?.body, { itemId: "o3", isArchived: true, archiveReason: "stale", archiveNote: "n" });
  assert.equal(await state().restoreResource("o3"), null);
  assert.deepEqual([state().overrides.get("o3")?.isArchived, state().overrides.get("o3")?.archivedAt, state().overrides.get("o3")?.archiveReason], [false, null, null]);
});

test("personal archive and restore: ungated, the entry follows the write, and a failure puts the previous entry back", async () => {
  reset();
  const sent = transport(ok);
  assert.equal(await state().archivePersonal("o3", ""), null);
  assert.deepEqual(sent[0], { path: "/api/workspace/personal-state", method: "POST", body: { itemId: "o3", isArchived: true, archiveNote: null } });
  assert.equal(state().personalState.get("o3")?.isArchived, true);
  transport(() => refuse(500, "db down"));
  assert.equal(await state().restorePersonal("o3"), "db down");
  assert.equal(state().personalState.get("o3")?.isArchived, true, "the entry is back after the failed restore");
  transport(ok);
  assert.equal(await state().restorePersonal("o3"), null);
  assert.equal(state().personalState.has("o3"), false);
});

test("owner, dismiss and restore-dismissed write the fields they change; dismiss clears the priority override", async () => {
  reset();
  const sent = transport(ok);
  await state().setOwner("o3", "u1", "Ada");
  assert.deepEqual([state().overrides.get("o3")?.ownerName, sent[0]?.body], ["Ada", { itemId: "o3", ownerUserId: "u1" }]);
  await state().setOwner("o3", null, "ignored");
  assert.equal(state().overrides.get("o3")?.ownerName, null);
  await state().updatePriority("o3", "HIGH");
  await state().dismissResource("o3");
  assert.deepEqual([state().overrides.get("o3")?.priorityOverride, typeof state().overrides.get("o3")?.dismissedAt], [null, "string"]);
  await state().restoreDismissed("o3");
  assert.equal(state().overrides.get("o3")?.dismissedAt, null);
});

test("signed out, a non-JSON failure and a network exception each give a plain message and roll back", async () => {
  reset();
  transport(ok, false);
  assert.equal(await state().updatePriority("o3", "LOW"), "You are signed out. Sign in and try again.");
  assert.equal(state().overrides.has("o3"), false);
  transport(() => new Response("<html>bad gateway</html>", { status: 502 }));
  assert.equal(await state().updatePriority("o3", "LOW"), "Request failed (502).");
  transport(() => new Error("offline"));
  assert.equal(await state().updatePriority("o3", "LOW"), "Network error. Your change was not saved.");
  assert.equal(state().overrides.has("o3"), false);
});

test("setOverrides and setPersonalState load the bootstrap rows into maps keyed by item id", () => {
  reset();
  state().setOverrides([ovr("a"), ovr("b")]);
  state().setPersonalState([personal("c")]);
  assert.deepEqual([[...state().overrides.keys()], [...state().personalState.keys()]], [["a", "b"], ["c"]]);
});

// ── the workspace store ──────────────────────────────────────────────────────────────────────────────

test("the AuthProvider seed fills the workspace store; a failed lookup writes nothing; a workspace-less user keeps an empty org", () => {
  useWorkspaceStore.setState({ orgId: null, orgName: "", userRole: null, sectorProfile: [] });
  applyWorkspaceSeed({ status: "error", orgId: undefined, orgName: "", role: null, sectors: ["x"] });
  assert.deepEqual([useWorkspaceStore.getState().orgId, useWorkspaceStore.getState().sectorProfile], [null, []]);
  applyWorkspaceSeed({ status: "resolved", orgId: "org-1", orgName: "Org One", role: "admin", sectors: ["fine-art"] });
  const s = useWorkspaceStore.getState();
  assert.deepEqual([s.orgId, s.orgName, s.userRole, s.sectorProfile], ["org-1", "Org One", "admin", ["fine-art"]]);
  applyWorkspaceSeed({ status: "resolved", orgId: null, orgName: "", role: null, sectors: [] });
  assert.deepEqual([useWorkspaceStore.getState().orgId, useWorkspaceStore.getState().sectorProfile], ["org-1", []]);
});
