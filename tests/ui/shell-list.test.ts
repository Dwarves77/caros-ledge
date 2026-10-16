import assert from "node:assert/strict";
import { test } from "node:test";

import type { Resource } from "@/core/types";
import { EMPTY_FILTER_STATE, filterByWindow, filterRows, sortResourceRows, withListPosition } from "@/ui/list-surface/filter-sort";
import { facetOptions, liveFacetCounts } from "@/ui/list-surface/facets";
import { parseListUrl, regionLinkHref, serializeListUrl } from "@/ui/list-surface/url-state";
import { gradientCountsFrom, isActivePath, isChromeless, navTitleForPath, SECTIONS, suppressesWorkspaceNote } from "@/ui/shell/nav-model";
import { shellNotes, workspaceLabel } from "@/ui/shell/identity-seed";
import { hydrateItemState, loadBootstrap, resetBootstrap, useBootstrapStore, type WorkspaceBootstrapData } from "@/ui/shell/use-bootstrap";
import { useItemStateStore } from "@/features/workspace/state";

const R = (over: Partial<Resource> & { id: string }): Resource => ({ cat: "air", sub: "", title: over.id, url: "", note: "", type: "regulation", priority: "HIGH", added: "2026-01-01", reasoning: "", tags: [], whatIsIt: "", whyMatters: "", keyData: [], ...over }) as Resource;
const NOW = new Date("2026-10-15T00:00:00Z");

test("nav-model: a path matches by segment, never by string prefix", () => {
  assert.equal(isActivePath("/market", "/market"), true);
  assert.equal(isActivePath("/market/abc", "/market"), true);
  assert.equal(isActivePath("/marketplace", "/market"), false);
  assert.equal(isActivePath("/", "/"), true);
  assert.equal(isActivePath("/regulations", "/"), false);
  assert.equal(navTitleForPath("/"), "Dashboard");
  assert.equal(navTitleForPath("/market/xyz"), "Market Intel");
  assert.equal(navTitleForPath("/marketplace"), "Caro's Ledge");
  assert.equal(navTitleForPath("/profile"), "Account");
  assert.equal(navTitleForPath("/map"), "Map");
  assert.equal(navTitleForPath("/mapping"), "Caro's Ledge");
  assert.equal(isChromeless("/auth/callback"), true);
  assert.equal(isChromeless("/author"), false);
  assert.equal(isChromeless("/privacy"), false, "/privacy shows the shell (the polls are gated by the session, not by the route)");
  assert.equal(isChromeless("/privacy/ui-fixtures"), true);
  assert.equal(isChromeless("/login"), true);
  assert.equal(isChromeless("/loginx"), false);
  assert.equal(isChromeless("/regulations"), false);
  assert.equal(suppressesWorkspaceNote("/invitations/tok"), true);
  assert.deepEqual(SECTIONS.map((s) => s.label), ["Brief", "Intelligence", "Network"]);
  assert.equal(gradientCountsFrom(null), null);
  assert.deepEqual(gradientCountsFrom({ CRITICAL: 1, HIGH: 2, MODERATE: 3, LOW: 4 }), { immediate: 1, action: 2, monitor: 3, awareness: 4 });
});

test("INV-139/149 as the shell reads them: the banner and redirect table across pending, resolved, error, signed-out", () => {
  const user = { id: "u" };
  const n = (over: object) => shellNotes({ user, orgId: "o", identityStatus: "resolved", pathname: "/regulations", ...over });
  assert.deepEqual(n({}), { noWorkspace: false, redirect: null, identityError: false });
  assert.deepEqual(n({ orgId: null }), { noWorkspace: true, redirect: "/workspace/new", identityError: false });
  assert.deepEqual(n({ orgId: undefined, identityStatus: "pending" }), { noWorkspace: false, redirect: null, identityError: false }, "pending says nothing");
  assert.deepEqual(n({ orgId: undefined, identityStatus: "error" }), { noWorkspace: false, redirect: null, identityError: true }, "a failed lookup is an error note, never no workspace");
  assert.deepEqual(n({ orgId: undefined }), { noWorkspace: false, redirect: null, identityError: false }, "an unresolved org is not no workspace");
  assert.deepEqual(n({ user: null, orgId: null }), { noWorkspace: false, redirect: null, identityError: false }, "signed out");
  assert.deepEqual(n({ user: null, orgId: undefined, identityStatus: "error" }), { noWorkspace: false, redirect: null, identityError: false });
  for (const path of ["/workspace/new", "/onboarding", "/invitations/t", "/login", "/signup", "/auth/callback", "/privacy"]) {
    assert.deepEqual(n({ orgId: null, pathname: path }), { noWorkspace: false, redirect: null, identityError: false }, path);
    assert.equal(n({ identityStatus: "error", pathname: path }).identityError, false, path);
  }
  assert.equal(workspaceLabel("pending", ""), "Loading workspace");
  assert.equal(workspaceLabel("error", ""), "Workspace unavailable");
  assert.equal(workspaceLabel("resolved", ""), "No workspace");
  assert.equal(workspaceLabel("resolved", "Acme"), "Acme");
});

test("the bootstrap hydrates the item-state stores once per bundle and a degraded field never clobbers state", () => {
  useItemStateStore.getState().setOverrides([{ itemId: "keep", priorityOverride: null, isArchived: true, archiveReason: null, archiveNote: null }]);
  const base: WorkspaceBootstrapData = { personalState: null, members: null, adminAttention: null, overrides: null, navCounts: null, assistantEnabled: false, degraded: ["overrides", "personal_state"] };
  hydrateItemState(base);
  assert.equal(useItemStateStore.getState().overrides.has("keep"), true, "a null overrides field leaves the store alone");
  hydrateItemState({ ...base, overrides: [], personalState: [{ itemId: "uuid", legacyId: "L9", title: null, isArchived: true, archiveNote: null, archivedAt: null }] });
  assert.equal(useItemStateStore.getState().overrides.size, 0, "an honest empty list does replace");
  assert.equal(useItemStateStore.getState().personalState.has("L9"), true, "the UI id is the legacy id");
});

test("signing out or changing user resets the bundle (the next user never sees the first one)", () => {
  resetBootstrap("u1");
  useBootstrapStore.setState({ data: { personalState: [], members: null, adminAttention: null, overrides: [], navCounts: null, assistantEnabled: true, degraded: [] }, status: "ready" });
  resetBootstrap("u2");
  const s = useBootstrapStore.getState();
  assert.equal(s.data, null);
  assert.equal(s.userId, "u2");
  assert.equal(s.status, "idle");
  resetBootstrap(null);
});

test("INV-267: live facet counts at rest use the corpus figures; with a selection each group excludes its own selection", () => {
  const rows = [R({ id: "a", priority: "CRITICAL", modes: ["air"], jurisdiction: "EU" }), R({ id: "b", priority: "HIGH", modes: ["air", "ocean"], jurisdiction: "EU" }), R({ id: "c", priority: "HIGH", modes: ["ocean"], jurisdiction: "US" })];
  const rest = liveFacetCounts(rows, EMPTY_FILTER_STATE, { byPriority: { CRITICAL: 10, HIGH: 20 }, byJurisdiction: { EU: 7, US: 5 }, totalItems: 99 });
  assert.equal(rest.liveSelection, false);
  assert.equal(rest.total, 99);
  assert.deepEqual(rest.band.map((b) => [b.key, b.count]), [["immediate", 10], ["action", 20], ["monitor", 0], ["awareness", 0]]);
  assert.deepEqual(rest.region.map((r) => [r.value, r.count]), [["EU", 7], ["US", 5]]);
  const one = liveFacetCounts(rows, { ...EMPTY_FILTER_STATE, mode: "air" }, { byPriority: { CRITICAL: 10 } });
  assert.equal(one.liveSelection, true);
  assert.equal(one.total, 2);
  assert.deepEqual(one.band.map((b) => b.count), [1, 1, 0, 0], "bands count over the air rows");
  assert.deepEqual(one.mode.map((m) => [m.value, m.count]).sort(), [["air", 2], ["ocean", 2]], "the mode group excludes its own selection");
  const two = liveFacetCounts(rows, { ...EMPTY_FILTER_STATE, mode: "air", region: "EU" });
  assert.equal(two.total, 2);
  assert.deepEqual(two.region.map((r) => [r.value, r.count]).sort(), [["EU", 2]], "region counts over the air rows, ignoring its own selection (US has no air row)");
  assert.deepEqual(facetOptions.tier([R({ id: "t", sourceTier: 3 }), R({ id: "u", sourceTier: 1 }), R({ id: "v" })]).map((o) => o.label), ["T1", "T3"]);
});

test("filters: the window keeps undated rows; the newest sort is NaN-safe; my-order is the identity", () => {
  const rows = [R({ id: "old", added: "2020-01-01" }), R({ id: "new", added: "2026-10-10" }), R({ id: "undated", added: "" }), R({ id: "junk", added: "not a date" })];
  assert.deepEqual(filterByWindow(rows, "7d", NOW).map((r) => r.id), ["new", "undated", "junk"]);
  assert.equal(filterByWindow(rows, "all", NOW), rows);
  const sorted = sortResourceRows(rows, "newest", NOW).map((r) => r.id);
  assert.deepEqual(sorted.slice(0, 2), ["new", "old"]);
  assert.equal(sortResourceRows(rows, "my-order", NOW), rows);
  const due = sortResourceRows([R({ id: "none" }), R({ id: "soon", complianceDeadline: "2026-10-20" }), R({ id: "later", complianceDeadline: "2026-12-20" })], "next-date", NOW).map((r) => r.id);
  assert.deepEqual(due, ["soon", "later", "none"]);
  assert.deepEqual(sortResourceRows([R({ id: "b" }), R({ id: "a" })], "az", NOW).map((r) => r.id), ["a", "b"]);
  assert.deepEqual(filterRows(rows, { ...EMPTY_FILTER_STATE, query: "OLD" }).map((r) => r.id), ["old"]);
  assert.deepEqual(filterRows([R({ id: "x", jurisdictionIso: ["fr"] })], { ...EMPTY_FILTER_STATE, region: "DE,FR" }).map((r) => r.id), ["x"], "a region token matches an ISO code, a comma list matches any");
  assert.equal(withListPosition("/regulations/a", "regulations", 3, 40, { prev: "p", next: "n x" }), "/regulations/a?list=regulations&pos=3&of=40&prev=p&next=n%20x");
});

test("INV-264: one URL vocabulary; every facet, sort, window and extra round-trips; the map region link resolves to the list region facet", () => {
  const state = { filter: { band: "action" as const, mode: "air", region: "EU", topic: "Carbon", tier: "2", query: "co2 limit" }, sort: "az" as const, window: "30d" as const, extras: { kind: "price" } };
  const qs = serializeListUrl(state);
  assert.deepEqual(parseListUrl(new URLSearchParams(qs), ["kind", "theme"]), state);
  assert.deepEqual(parseListUrl(new URLSearchParams("band=bogus&sort=nope&window=1y&q=%20"), []), { filter: EMPTY_FILTER_STATE, sort: null, window: null, extras: {} });
  assert.equal(serializeListUrl({}), "");
  assert.deepEqual(parseListUrl(new URLSearchParams("kind=a&theme=b&other=c"), ["kind"]).extras, { kind: "a" }, "only declared extras are read");
  assert.equal(regionLinkHref("/regulations", ["de", " fr ", "DE", "bad code!"]), "/regulations?region=DE%2CFR");
  assert.equal(regionLinkHref("/regulations", []), "/regulations");
  assert.equal(regionLinkHref("/regulations", null), "/regulations");
});

test("a bundle that arrives after a sign-out or a user change is discarded", async () => {
  resetBootstrap("u1");
  let release: (r: Response) => void = () => {};
  const slow = () => new Promise<Response>((res) => (release = res));
  const pending = loadBootstrap("u1", slow as unknown as typeof fetch, async () => ({ Authorization: "Bearer x" }));
  await new Promise((r) => setTimeout(r, 0));
  resetBootstrap("u2");
  release(Response.json({ personalState: [], members: null, adminAttention: null, overrides: [], navCounts: null, assistantEnabled: true, degraded: [] }));
  await pending;
  assert.equal(useBootstrapStore.getState().data, null);
  assert.equal(useBootstrapStore.getState().userId, "u2");
  const ok = loadBootstrap("u2", (async () => Response.json({ personalState: [], members: null, adminAttention: null, overrides: [], navCounts: null, assistantEnabled: true, degraded: [] })) as unknown as typeof fetch, async () => ({ Authorization: "Bearer x" }));
  await ok;
  assert.equal(useBootstrapStore.getState().status, "ready");
  const failed = loadBootstrap("u3", (async () => new Response("x", { status: 500 })) as unknown as typeof fetch, async () => ({ Authorization: "Bearer x" }));
  resetBootstrap("u3");
  await failed;
  resetBootstrap("u3");
  await loadBootstrap("u3", (async () => new Response("x", { status: 500 })) as unknown as typeof fetch, async () => ({ Authorization: "Bearer x" }));
  assert.equal(useBootstrapStore.getState().status, "failed", "a failed bundle read is a failed state, not an empty bundle");
  assert.equal(useBootstrapStore.getState().data, null);
  resetBootstrap(null);
});
