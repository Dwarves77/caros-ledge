// INV-263 on every Community page, and the page wiring. The pages are the real server components rendered to markup over the community world (tests/community/_world.ts, the row policies emulated). A read that fails is a
// STATED failure with Retry, never a short list, a zero or "private"; and the production state before the cutover (none of this slice's database objects exist) renders every page with its controls and a stated note.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement, type ReactNode } from "react";

import { BrowsePage } from "@/features/community/pages/Browse";
import { DirectoryPage } from "@/features/community/pages/Directory";
import { DiscoverPage } from "@/features/community/pages/Discover";
import { GroupPage } from "@/features/community/pages/Group";
import { ModerationPage } from "@/features/community/pages/Moderation";
import { ProfilePage } from "@/features/community/pages/Profile";
import { RoomsPage } from "@/features/community/pages/Rooms";
import { useToast } from "@/features/community/ui/toast";

import { renderApp, textOf } from "../_support/render.ts";
import { scripted } from "../_support/fake-clients.ts";
import { sweepPage, type SweepWorld } from "../_support/page-sweep.ts";
import routeSweep from "../surfaces/route-sweep.json" with { type: "json" };

import { asClient, ROOM_EU, USER, world, type Viewer, type World } from "./_world.ts";

const SLUG = "grp-fine-art-room";
interface PageSpec {
  name: string;
  path: string;
  render: () => Promise<ReactNode>;
}
const PAGES: PageSpec[] = [
  { name: "/community", path: "/community", render: () => RoomsPage() },
  { name: "/community/[slug]", path: `/community/${SLUG}`, render: () => GroupPage({ slug: SLUG }) },
  { name: "/community/browse", path: "/community/browse", render: () => BrowsePage({ region: "EU" }) },
  { name: "/community/directory", path: "/community/directory", render: () => DirectoryPage() },
  { name: "/community/discover", path: "/community/discover", render: () => DiscoverPage() },
  { name: "/community/moderation", path: "/community/moderation", render: () => ModerationPage() },
  { name: "/community/profile", path: "/community/profile", render: () => ProfilePage() },
];
const as = (db: World, who: Viewer) => void (scripted.user = () => asClient(db, who));
async function draw(spec: PageSpec): Promise<{ html: string; text: string }> {
  const html = renderApp((await spec.render()) as never, { path: spec.path });
  return { html, text: textOf(html) };
}
/** The world behind the shared page sweep (tests/_support/page-sweep.ts): a fresh Community world, a member signed in, the reads a draw made and the refusal of one by name. */
function communityWorld(): SweepWorld {
  const db = world();
  as(db, "member");
  return {
    reads: () => ({ tables: [...new Set(db.reads().map((c) => c.table))], rpcs: [...new Set(db.rpcLog)] }),
    failTable: (table) => void db.fail(table, "select", "refused by the fake client"),
    failRpc: (rpc) => void db.rpcFail.set(rpc, { message: "refused by the fake client" }),
  };
}
/** Every control a page offers: the text of each button and the target of each link. */
const controlsOf = (html: string): string[] =>
  [...new Set([...[...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => "button:" + textOf(m[1] ?? "")), ...[...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((m) => "link:" + m[1])])].sort();
/** Reads whose failure is a documented fall-back that shows nothing wrong: the admin bit is a display gate (false), the footer name falls back to the account's, the identity reads degrade every author to anonymous. */
const FALLS_BACK = new Set(["is_platform_admin", "my_profile"]);
/** Reads the Rooms page makes only because the shared listing reader enriches rows (a timeline, an override badge): it draws neither, so their refusal changes nothing it shows. */
const NOT_DRAWN: Record<string, string[]> = { "/community": ["item_timelines", "workspace_item_overrides"] };

test("INV-263: every page draws, healthy, with its heading and its controls", async () => {
  const expectations: Record<string, RegExp[]> = {
    "/community": [/Pending invitations|Jump back in/, /EU room/, /Browse all groups/, /Moderation queue/],
    "/community/[slug]": [/Air Freight Room/, /Star/, /Mute/, /Members/, /Start a post/, /No direct messaging/],
    "/community/browse": [/Browse public groups/, /Air Freight Room/, /European Union/],
    "/community/directory": [/Peer-organisation directory/],
    "/community/discover": [/Discover by entity/],
    "/community/moderation": [/Moderation queue/, /Open/, /Resolved/, /Dismissed/],
    "/community/profile": [/Your community profile/],
  };
  for (const spec of PAGES) {
    const db = world();
    as(db, "member");
    const { text } = await draw(spec);
    for (const re of expectations[spec.name] ?? []) assert.match(text, re, `${spec.name}: ${re}`);
    assert.doesNotMatch(text, /did not load/, spec.name);
  }
});

// ── the sweep: each read a page makes is refused in turn ─────────────────────────────────────────────────────────

const SWEPT = PAGES;
for (const spec of SWEPT) {
  test(`INV-263 ${spec.name}: a read refused is a stated failure with Retry, for every table and rpc the page reads`, async () => {
    const r = await sweepPage({ name: spec.name, draw: async () => (await draw(spec)).text, fallsBack: [...FALLS_BACK], notDrawn: NOT_DRAWN[spec.name] ?? [] }, communityWorld);
    assert.deepEqual(r.problems, [], `${spec.name}: the sweep cannot prove this page`);
    assert.deepEqual(r.silent, [], `${spec.name}: a refused read drew a page with no stated failure`);
  });
}

test("G5: the pages this file sweeps are exactly the routes tests/surfaces/route-sweep.json says it sweeps", () => {
  const mine = Object.entries(routeSweep.routes as Record<string, { swept?: string }>).filter(([, e]) => e.swept === "tests/community/pages.test.ts").map(([r]) => r).sort();
  assert.deepEqual(SWEPT.map((p) => p.name).sort(), mine);
});

test("INV-263 /community: each block that fails says so inside the page; the rest draws; the failed number is a dash, never a zero or 'no discussions yet'", async () => {
  const room = async (fail: (db: World) => void) => {
    const db = world();
    as(db, "nonMember");
    fail(db);
    return draw(PAGES[0] as PageSpec);
  };
  const threads = await room((db) => db.fail("community_posts", "select", "down"));
  assert.match(threads.text, /could not be loaded/);
  assert.doesNotMatch(threads.text, /no discussions yet/, "a room whose threads could not be read is not 'no discussions yet'");
  assert.match(threads.text, /Pending invitations/, "the invitation panel still draws");
  assert.match(threads.text, /Retry/);
  const ledger = await room((db) => db.rpcFail.set("get_workspace_intelligence_listings", { message: "down" }));
  assert.match(ledger.text, /ledger counts could not be loaded/i);
  assert.match(ledger.text, /· — active item/, "the header dash, not '0 active items'");
  const groups = await room((db) => db.fail("community_groups", "select", "down"));
  assert.match(groups.text, /regional rooms could not be loaded/i);
  assert.doesNotMatch(groups.text, /not open yet/, "a failed read is not 'the rooms are not open yet'");
  const roster = await room((db) => db.fail("profiles", "select", "down", { when: (c) => c.filters.some((f) => f[1] === "org_id") }));
  assert.match(roster.text, /Who is in each room could not be loaded/);
  const required = await room((db) => db.fail("community_group_invitations", "select", "down"));
  assert.match(required.text, /Community did not load/, "a read the page cannot be drawn without is the page's stated failure");
  assert.match(required.text, /Try again/);
});

test("INV-263: a refused region count is the page's stated failure on every sub-page (never a sidebar of zeros)", async () => {
  for (const spec of PAGES.slice(1)) {
    const db = world();
    as(db, "member");
    db.rpcFail.set("community_region_counts", { message: "down" });
    const { text } = await draw(spec);
    assert.match(text, /did not load/, spec.name);
    assert.match(text, /Try again/, spec.name);
  }
});

test("INV-263 /community/[slug]: a group that does not exist or is private to a stranger is a 404 that says nothing; a READ ERROR is a stated failure, never a 404", async () => {
  const missing = world();
  as(missing, "member");
  await assert.rejects(GroupPage({ slug: "no-such-group" }), (e: { digest?: string }) => /404|NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND/.test(String(e.digest ?? e)));
  const priv = world();
  as(priv, "nonMember");
  await assert.rejects(GroupPage({ slug: "grp-private" }), (e: { digest?: string }) => /404|NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND/.test(String(e.digest ?? e)), "a private group answers a stranger as a group that does not exist");
  const broken = world();
  as(broken, "member");
  broken.fail("community_groups", "select", "down");
  const { text } = await draw(PAGES[1] as PageSpec);
  assert.match(text, /This group did not load/);
});

test("INV-263 members rail: a roster that cannot be read is a stated failure with Retry, never the private-group message; a withheld name is a withheld name", async () => {
  const db = world();
  as(db, "member");
  db.fail("community_group_members", "select", "down", { when: (c) => c.filters.some((f) => f[1] === "group_id") && !c.filters.some((f) => f[1] === "user_id") });
  const { text } = await draw(PAGES[1] as PageSpec);
  assert.match(text, /The members could not be loaded/);
  assert.match(text, /Retry/);
  assert.doesNotMatch(text, /private/i);
});

test("the directory: a cell below the floor of five organisations is not drawn even if the database sent it; five is; a refused rpc is a stated failure", async () => {
  const db = world();
  as(db, "member");
  db.directory = [
    { dimension: "org_region", org_type: "forwarder", region: "EU", sector: "", members: 3, verified_members: 1 },
    { dimension: "org_region", org_type: "carrier", region: "EU", sector: "", members: 5, verified_members: 2 },
  ];
  const { text } = await draw(PAGES[3] as PageSpec);
  assert.match(text, /Carrier/);
  assert.doesNotMatch(text, /Freight forwarder/, "the cell of three is withheld");
  const none = world();
  as(none, "member");
  none.directory = [{ dimension: "org_region", org_type: "forwarder", region: "EU", sector: "", members: 4, verified_members: 0 }];
  assert.match((await draw(PAGES[3] as PageSpec)).text, /nothing is shown/);
});

// ── production before the cutover: none of this slice's database objects exist ─────────────────────────────────────

test("production before the cutover: with every new object absent, every page renders, keeps its controls and links, and says what is unavailable; nothing is a zero", async () => {
  for (const spec of PAGES) {
    const db = world();
    as(db, "member");
    for (const rpc of ["community_directory_counts", "community_notification_counts", "create_thread", "create_group_for_self", "accept_group_invitation", "decide_signoff", "moderate_report"]) db.rpcFail.set(rpc, { message: `Could not find the function public.${rpc} in the schema cache`, code: "PGRST202" });
    db.fail("community_group_bans", "select", 'relation "public.community_group_bans" does not exist', { code: "42P01" });
    const healthy = world();
    as(healthy, "member");
    const baseline = controlsOf((await draw(spec)).html);
    as(db, "member");
    const { html, text } = await draw(spec);
    assert.doesNotMatch(text, /Application error|undefined|NaN|\[object/, spec.name);
    const now = controlsOf(html);
    assert.deepEqual(baseline.filter((c) => !now.includes(c)), [], `${spec.name}: every control and link the page has when healthy is still there`);
    if (spec.name === "/community/directory") {
      assert.match(text, /The directory could not be loaded/);
      assert.match(text, /Retry/);
    } else assert.doesNotMatch(text, /did not load/, `${spec.name}: the rest of the page draws`);
  }
});

// ── the wiring defects ─────────────────────────────────────────────────────────────────────────────────────────────

test("wiring 1: a pending invitation can be answered from /community (the panel was never mounted by the page)", async () => {
  const db = world();
  as(db, "nonMember");
  const { text, html } = await draw(PAGES[0] as PageSpec);
  assert.match(text, /Pending invitations \(1\)/);
  assert.match(text, /Air Freight Room/);
  assert.ok(/>Accept</.test(html) && />Decline</.test(html), "both answers are controls on the page");
  const plain = world();
  as(plain, "member");
  assert.doesNotMatch((await draw(PAGES[0] as PageSpec)).text, /Pending invitations/, "no panel when there is nothing pending");
});

test("wiring 2: the group page and the moderation page mount the toast provider (a part's useToast throws outside one, so a missing toast is a crash and not a silent failure)", async () => {
  function Probe() {
    useToast();
    return null;
  }
  assert.throws(() => renderApp(createElement(Probe)), /outside a ToastProvider/);
  for (const spec of [PAGES[1], PAGES[5]] as PageSpec[]) {
    const db = world();
    as(db, "member");
    await assert.doesNotReject(draw(spec), spec.name);
  }
});

test("a room tile and a Join control reach the route, not a table (wiring 3 is proven in structure.test.ts); the EU room joins through the page's data", async () => {
  const db = world();
  as(db, "member");
  const { text } = await draw(PAGES[0] as PageSpec);
  assert.match(text, /EU room 1 — Joined/);
  assert.equal(db.group(ROOM_EU)?.slug, "room-eu");
  assert.equal(USER.member.length, 36);
});

test("the shell context: the admin bit is a display gate and fails closed (a refused rpc is 'not an admin'), a refused footer name falls back to the account's, and no page asks the auth server for the user", async () => {
  const { loadShellContext } = await import("@/features/community/lib/shell-context");
  const session = { userId: USER.platformAdmin, email: "pat@example.test", orgName: "Org A" };
  const admin = world();
  assert.equal((await loadShellContext(asClient(admin, "platformAdmin"), session)).currentUser.isPlatformAdmin, true);
  const closed = world();
  closed.rpcFail.set("is_platform_admin", { message: "down" });
  assert.equal((await loadShellContext(asClient(closed, "platformAdmin"), session)).currentUser.isPlatformAdmin, false, "a refused rpc never makes a member an admin");
  const noName = world();
  noName.rpcFail.set("my_profile", { message: "down" });
  assert.equal((await loadShellContext(asClient(noName, "platformAdmin"), session)).currentUser.name, "pat", "the account's own name, not a blank");
  const db = world();
  as(db, "member");
  for (const spec of PAGES) await draw(spec);
  assert.equal(db.authCalls, 0, "seven pages rendered, no getUser round trip");
});
