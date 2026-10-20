// IMP-119 for every surface that is not Community (INV-263, mechanical): each server page is drawn healthy, every table and rpc it read is recorded, and the page is drawn again once per read with that read refused. A page that draws
// without a NEW stated failure (a "did not load", a "could not be loaded", a Retry the healthy draw did not carry) has a silent read, and the build fails. The helper is tests/_support/page-sweep.ts; Community's pages run through it too
// (tests/community/pages.test.ts). tests/surfaces/route-sweep.json says, for every route in src/app, which sweep draws it or why none needs to; the last tests here hold that list to the file system.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createElement, type ReactNode } from "react";


import { appRoutes, importClosure, readersIn, routeProblems } from "../_support/app-routes.ts";
import { renderApp, textOf } from "../_support/render.ts";
import { STATED, sweepPage, type SweepPage, type SweepWorld } from "../_support/page-sweep.ts";
import { adminWorld, memberWorld, serviceWorld } from "../_support/sweep-worlds.ts";

import register from "./known-silent-reads.json" with { type: "json" };
import routeSweep from "./route-sweep.json" with { type: "json" };

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const drawn = async (path: string, render: () => Promise<ReactNode>): Promise<string> => textOf(renderApp((await render()) as never, { path }));
const THIS_FILE = "tests/surfaces/page-sweep.test.ts";

/** The reads whose failure is a documented fall-back that shows nothing wrong: the platform-admin bit is a display gate that fails closed (a refused rpc is "not an admin", never a member made an admin). */
const ADMIN_BIT = ["is_platform_admin"];
interface Swept extends SweepPage {
  /** The world the page is drawn over; a member's by default. */
  world?: () => SweepWorld;
}
const member = (name: string, path: string, render: () => Promise<ReactNode>): Swept => ({ name, draw: () => drawn(path, render), fallsBack: ADMIN_BIT });
/** The console's own copy holds "could not" in a sentence about sources the gates could not place; it is masked before the text is read for a stated failure. */
const admin = (name: string, path: string, render: () => Promise<ReactNode>): Swept => ({ name, draw: () => drawn(path, render), fallsBack: ADMIN_BIT, world: adminWorld, staticCopy: ["could not place on their own"] });
const PAGES: Swept[] = [
  member("/", "/", async () => (await import("@/features/dashboard/page")).default()),
  member("/watchlist", "/watchlist", async () => (await import("@/features/watchlist/page")).default()),
  member("/search", "/search", async () => (await import("@/features/search/page")).default({ searchParams: Promise.resolve({ q: "fuel" }) })),
  member("/settings", "/settings", async () => (await import("@/features/settings/page")).default()),
  member("/regulations", "/regulations", async () => (await import("@/features/regulations/pages")).RegulationsIndex()),
  member("/market", "/market", async () => (await import("@/features/market/page")).default()),
  member("/research", "/research", async () => (await import("@/features/research/page")).ResearchRoute()),
  member("/operations", "/operations", async () => (await import("@/features/operations/page")).OperationsRoute()),
  member("/profile", "/profile", async () => (await import("@/features/account/page")).default({ searchParams: Promise.resolve({}) })),
  member("/dashboard/portfolio", "/dashboard/portfolio", async () => (await import("@/features/portfolio/pages")).PortfolioIndexRoute()),
  member("/regulations/register", "/regulations/register", async () => (await import("@/features/regulations/pages")).ObligationRegisterRoute()),
  member("/market/series", "/market/series", async () => (await import("@/features/market/series-page")).default()),
  member("/onboarding", "/onboarding", async () => (await import("@/features/onboarding/pages")).OnboardingRoute()),
  member("/regulations/[slug]", "/regulations/o3", async () => (await import("@/features/regulations/pages")).RegulationDetailRoute({ params: Promise.resolve({ slug: "o3" }) })),
  member("/market/[slug]", "/market/m1", async () => (await import("@/features/market/detail-page")).MarketDetailRoute({ params: Promise.resolve({ slug: "m1" }) })),
  member("/research/[slug]", "/research/r1", async () => (await import("@/features/research/detail-page")).ResearchDetailRoute({ params: Promise.resolve({ slug: "r1" }) })),
  member("/operations/[slug]", "/operations/o1", async () => (await import("@/features/operations/detail-page")).OperationsDetailRoute({ params: Promise.resolve({ slug: "o1" }) })),
  member("/map", "/map", async () => (await import("@/features/regulations/map/route")).MapRoute({ searchParams: Promise.resolve({}) })),
  member("/dashboard/portfolio/[id]", "/dashboard/portfolio/p", async () => (await import("@/features/portfolio/pages")).PortfolioDetailRoute({ params: Promise.resolve({ id: (await import("../_support/sweep-worlds.ts")).PORTFOLIO }) })),
  { ...member("/dashboard/coverage", "/dashboard/coverage", async () => (await import("@/features/coverage/page")).default({ searchParams: Promise.resolve({}) })), world: serviceWorld },
  admin("/admin", "/admin", async () => (await import("@/features/admin/pages")).AdminRoute()),
  admin("/admin/factors", "/admin/factors", async () => (await import("@/features/admin/pages")).FactorsRoute()),
  admin("/admin/inferences", "/admin/inferences", async () => (await import("@/features/admin/pages")).InferencesRoute()),
  admin("/admin/items/[id]", "/admin/items/x", async () => (await import("@/features/admin/pages")).ItemCorrectionsRoute({ params: Promise.resolve({ id: "aaaaaaaa-0000-4000-8000-000000000001" }) })),
];

for (const page of PAGES) {
  test(`INV-263 ${page.name}: drawn healthy it says nothing is wrong, and a read refused is a stated failure with Retry, for every table and rpc the page reads`, async () => {
    const world = page.world ?? memberWorld;
    const r = await sweepPage(page, world);
    assert.deepEqual(r.problems, [], `${page.name}: the sweep cannot prove this page`);
    const known = Object.keys((register.pages as Record<string, Record<string, unknown>>)[page.name] ?? {}).sort();
    assert.deepEqual(r.silent.sort(), known, `${page.name}: the silent reads are not the register's (a new silent read fails the build; a fixed one must leave tests/surfaces/known-silent-reads.json)`);
  });
}

// ── the sweep can fail (G5): each planted fault below was passed by the old sweep ───────────────────────────────────────────────────────────────────────────────────
/** A planted page: reads a table and an rpc, and `copy` is what it prints; `states` makes it say so when a read fails. */
const planted = (opts: { swallow: boolean; staticCopy?: string; reads?: boolean }): SweepPage => ({
  name: "planted",
  draw: async (world: SweepWorld) => {
    const client = (world as Any).db;
    const parts: string[] = [opts.staticCopy ?? "A page of figures."];
    if (opts.reads !== false) {
      const t = await client.from("user_watchlist").select("id");
      const r = await client.rpc("get_surface_counts", { p_org_id: "o", p_surface: "regulations" });
      const count = (Array.isArray(r.data) ? r.data : []).length;
      parts.push(opts.swallow ? `${(t.data ?? []).length} watched, ${count} counted` : `${t.error ? "The watchlist could not be loaded. Try again." : `${(t.data ?? []).length} watched`} ${r.error ? "Counts did not load. Retry" : `${count} counted`}`);
    }
    return textOf(renderApp(createElement("p", null, parts.join(" ")), { path: "/planted" }));
  },
});

test("the sweep goes red on a planted silent read: a page that reads a table and ignores the error, and one that reads an rpc and draws a zero, are each reported by name; a page that states its failure is not", async () => {
  const silent = await sweepPage(planted({ swallow: true }), memberWorld);
  assert.deepEqual(silent.silent.sort(), ["rpc get_surface_counts", "table user_watchlist"]);
  assert.deepEqual(silent.problems, []);
  const stating = await sweepPage(planted({ swallow: false }), memberWorld);
  assert.deepEqual(stating.silent, []);
  assert.deepEqual(stating.problems, []);
});

test("G5 planted: a page whose static copy says Retry and ignores a refused read is red (it used to pass: every refused draw matched the phrase)", async () => {
  const r = await sweepPage(planted({ swallow: true, staticCopy: "Anything wrong? Retry from the menu." }), memberWorld);
  assert.equal(r.problems.length, 1, "the healthy draw already matches STATED, so the sweep says it proves nothing");
  assert.match(r.problems[0] as string, /already matches STATED \("Retry"\)/);
  assert.deepEqual(r.silent.sort(), ["rpc get_surface_counts", "table user_watchlist"], "both reads are silent too: their refused draws are the healthy text");
});

test("G5 planted: a page that draws the same text whatever is refused is reported silent even when it holds a stated phrase", async () => {
  const page: SweepPage = { name: "constant", draw: async (world) => { await (world as Any).db.from("profiles").select("id"); return "The same text."; } };
  assert.deepEqual((await sweepPage(page, memberWorld)).silent, ["table profiles"]);
});

test("G5 planted: a page with no refusable read is vacuous and fails, and so does a page whose only reads are all named as fall-backs", async () => {
  const none = await sweepPage(planted({ swallow: false, reads: false }), memberWorld);
  assert.deepEqual(none.problems, ["the page makes no refusable read: the sweep is vacuous"]);
  const onlyFallback: SweepPage = { name: "fallback", fallsBack: ["is_platform_admin"], draw: async (world) => { await (world as Any).db.rpc("is_platform_admin"); return "A page."; } };
  assert.deepEqual((await sweepPage(onlyFallback, memberWorld)).problems, ["the page makes no refusable read: the sweep is vacuous"]);
});

test("a read the page makes only to enrich rows it never draws may be named in notDrawn, and a documented fall-back in fallsBack; anything else a refused read changes must be stated", async () => {
  const page: SweepPage = { name: "enriches", draw: async (world) => ((await (world as Any).db.from("profiles").select("id")).error ? "fine" : "fine"), notDrawn: ["profiles"] };
  assert.deepEqual((await sweepPage(page, memberWorld)).silent, []);
  assert.deepEqual((await sweepPage({ ...page, notDrawn: [] }, memberWorld)).silent, ["table profiles"]);
});

test("the register of known silent reads is made of findings: each carries a status token, the slice that owes the fix and the finding, and every page it names is swept", () => {
  const pages = register.pages as Record<string, Record<string, { status: string; owner: string; finding: string }>>;
  assert.deepEqual(Object.keys(pages).filter((p) => !PAGES.some((x) => x.name === p)), [], "a register entry for a page the sweep does not draw");
  for (const [page, reads] of Object.entries(pages)) {
    for (const [read, f] of Object.entries(reads)) {
      assert.match(read, /^(table|rpc) [a-z_]+$/, `${page}: ${read}`);
      assert.ok(["CONFIRMED", "HYPOTHESIS"].includes(f.status), `${page} ${read}: a finding is CONFIRMED or a HYPOTHESIS (rule 14)`);
      assert.ok(f.owner.length > 3 && f.finding.length > 40, `${page} ${read}: an owner and a finding`);
    }
  }
});

// ── the sweep covers the whole app (G5): every route is swept or exempt with a reason ──────────────────────────────────────────────────────────────────────────────
type Entry = { swept?: string; exempt?: string; readers?: string[]; readersReason?: string };
const ROUTES = routeSweep.routes as Record<string, Entry>;

test("G5: every page and route handler under src/app is in tests/surfaces/route-sweep.json, and nothing in it names a route that is gone", () => {
  const { unlisted, stale } = routeProblems(appRoutes().map((r) => r.route), Object.keys(ROUTES));
  assert.deepEqual(unlisted, [], "a route in src/app that no sweep draws and no exemption explains");
  assert.deepEqual(stale, [], "an entry for a route that does not exist");
});

test("G5 planted: a route that is on disk and not in the list is red, and so is a list entry whose route is gone; the old routes the sweep never drew are enumerated", () => {
  assert.deepEqual(routeProblems(["/map", "/brand-new"], ["/map"]), { unlisted: ["/brand-new"], stale: [] });
  assert.deepEqual(routeProblems(["/map"], ["/map", "/gone"]), { unlisted: [], stale: ["/gone"] });
  const found = appRoutes().map((r) => r.route);
  assert.ok(found.includes("/map") && found.includes("/dashboard/portfolio/[id]") && found.includes("/dashboard/coverage"), "the routes the old sweep never drew are enumerated");
  assert.ok(!found.some((r) => r.startsWith("/privacy/ui-fixtures") || r.startsWith("/api")), "fixture mounts and API routes are not product pages");
});

test("G5: the pages this file draws are exactly the routes the registry says it draws; each exemption carries a reason", () => {
  const mine = Object.entries(ROUTES).filter(([, e]) => e.swept === THIS_FILE).map(([r]) => r).sort();
  assert.deepEqual(PAGES.map((p) => p.name).sort(), mine);
  for (const [route, e] of Object.entries(ROUTES)) {
    assert.ok(Boolean(e.swept) !== Boolean(e.exempt), `${route}: swept or exempt, not both and not neither`);
    if (e.exempt) assert.ok(e.exempt.length >= 30, `${route}: an exemption says why in a sentence`);
  }
});

test("G5 reader detection: a route that no sweep draws reaches no module that reads the database, except the readers its exemption names with the reason (an exempt page cannot read silently)", () => {
  const files = new Map(appRoutes().map((r) => [r.route, r.file]));
  const actual: Record<string, string[]> = {};
  const expected: Record<string, string[]> = {};
  for (const [route, e] of Object.entries(ROUTES)) {
    if (!e.exempt) continue;
    actual[route] = readersIn(importClosure([files.get(route) as string]));
    expected[route] = [...(e.readers ?? [])].sort();
    if (e.readers) assert.ok((e.readersReason ?? "").length >= 40, `${route}: readers named in an exemption say why in a sentence`);
  }
  assert.deepEqual(actual, expected, "an exempt route reaches modules that read the database (name them in `readers` with `readersReason`, or sweep the page)");
});

test("G5 reader detection finds a planted reader: a module with .from(\"table\") or .rpc(\"name\") is reported, Array.from and Buffer.from are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "readers-"));
  const write = (name: string, text: string) => {
    const f = join(dir, name);
    writeFileSync(f, text);
    return f;
  };
  const reader = write("reader.ts", 'export const a = (db: any) => db.from("regulations").select("id");\n');
  const rpc = write("rpc.ts", 'export const a = (db: any) => db.rpc("get_counts");\n');
  const quiet = write("quiet.ts", 'export const a = Array.from([1]); export const b = Buffer.from("x");\n');
  assert.deepEqual(readersIn(new Set([reader, rpc, quiet])).map((f) => f.split("/").pop()).sort(), ["reader.ts", "rpc.ts"]);
});

test("STATED is the one vocabulary of a stated failure", () => {
  for (const w of ["did not load", "could not be loaded", "Try again", "Retry", "Application error"]) assert.match(w, STATED);
  assert.doesNotMatch("Watched · 4 items", STATED);
});
