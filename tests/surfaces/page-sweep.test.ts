// IMP-119 for every surface that is not Community (INV-263, mechanical): each server page is drawn healthy, every table and rpc it read is recorded, and the page is drawn again once per read with that read refused. A page that draws
// without a stated failure (a "did not load", a "could not be loaded", a Retry) has a silent read, and the build fails. The helper is tests/_support/page-sweep.ts; Community's pages run through it too (tests/community/pages.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement, type ReactNode } from "react";


import { renderApp, textOf } from "../_support/render.ts";
import { STATED, sweepPage, type SweepPage, type SweepWorld } from "../_support/page-sweep.ts";
import { memberWorld } from "../_support/sweep-worlds.ts";

import register from "./known-silent-reads.json" with { type: "json" };

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const drawn = async (path: string, render: () => Promise<ReactNode>): Promise<string> => textOf(renderApp((await render()) as never, { path }));

/** The reads whose failure is a documented fall-back that shows nothing wrong: the platform-admin bit is a display gate that fails closed (a refused rpc is "not an admin", never a member made an admin). */
const ADMIN_BIT = ["is_platform_admin"];
const PAGES: SweepPage[] = [
  { name: "/ (Dashboard)", draw: () => drawn("/", async () => (await import("@/features/dashboard/page")).default()), fallsBack: ADMIN_BIT },
  { name: "/watchlist", draw: () => drawn("/watchlist", async () => (await import("@/features/watchlist/page")).default()), fallsBack: ADMIN_BIT },
  { name: "/search", draw: () => drawn("/search", async () => (await import("@/features/search/page")).default({ searchParams: Promise.resolve({ q: "fuel" }) })), fallsBack: ADMIN_BIT },
  { name: "/settings", draw: () => drawn("/settings", async () => (await import("@/features/settings/page")).default()), fallsBack: ADMIN_BIT },
  { name: "/regulations", draw: () => drawn("/regulations", async () => (await import("@/features/regulations/pages")).RegulationsIndex()), fallsBack: ADMIN_BIT },
  { name: "/market", draw: () => drawn("/market", async () => (await import("@/features/market/page")).default()), fallsBack: ADMIN_BIT },
  { name: "/research", draw: () => drawn("/research", async () => (await import("@/features/research/page")).ResearchRoute()), fallsBack: ADMIN_BIT },
  { name: "/operations", draw: () => drawn("/operations", async () => (await import("@/features/operations/page")).OperationsRoute()), fallsBack: ADMIN_BIT },
  { name: "/profile", draw: () => drawn("/profile", async () => (await import("@/features/account/page")).default({ searchParams: Promise.resolve({}) })), fallsBack: ADMIN_BIT },
  { name: "/dashboard/portfolio", draw: () => drawn("/dashboard/portfolio", async () => (await import("@/features/portfolio/pages")).PortfolioIndexRoute()), fallsBack: ADMIN_BIT },
  { name: "/regulations/register", draw: () => drawn("/regulations/register", async () => (await import("@/features/regulations/pages")).ObligationRegisterRoute()), fallsBack: ADMIN_BIT },
  { name: "/market/series", draw: () => drawn("/market/series", async () => (await import("@/features/market/series-page")).default()), fallsBack: ADMIN_BIT },
  { name: "/onboarding", draw: () => drawn("/onboarding", async () => (await import("@/features/onboarding/pages")).OnboardingRoute()), fallsBack: ADMIN_BIT },
  { name: "/regulations/[slug]", draw: () => drawn("/regulations/o3", async () => (await import("@/features/regulations/pages")).RegulationDetailRoute({ params: Promise.resolve({ slug: "o3" }) })), fallsBack: ADMIN_BIT },
  { name: "/market/[slug]", draw: () => drawn("/market/m1", async () => (await import("@/features/market/detail-page")).MarketDetailRoute({ params: Promise.resolve({ slug: "m1" }) })), fallsBack: ADMIN_BIT },
  { name: "/research/[slug]", draw: () => drawn("/research/r1", async () => (await import("@/features/research/detail-page")).ResearchDetailRoute({ params: Promise.resolve({ slug: "r1" }) })), fallsBack: ADMIN_BIT },
  { name: "/operations/[slug]", draw: () => drawn("/operations/o1", async () => (await import("@/features/operations/detail-page")).OperationsDetailRoute({ params: Promise.resolve({ slug: "o1" }) })), fallsBack: ADMIN_BIT },
];

for (const page of PAGES) {
  test(`INV-263 ${page.name}: drawn healthy it says nothing is wrong, and a read refused is a stated failure with Retry, for every table and rpc the page reads`, async () => {
    const healthy = memberWorld();
    const text = await page.draw(healthy);
    assert.doesNotMatch(text, STATED, `${page.name}: the healthy page already shows a failure, so the sweep would prove nothing`);
    const r = await sweepPage(page, memberWorld);
    assert.ok(r.tables.length + r.rpcs.length > 0, `${page.name} reads something`);
    const known = Object.keys((register.pages as Record<string, Record<string, unknown>>)[page.name] ?? {}).sort();
    assert.deepEqual(r.silent.sort(), known, `${page.name}: the silent reads are not the register's (a new silent read fails the build; a fixed one must leave tests/surfaces/known-silent-reads.json)`);
  });
}

test("the sweep goes red on a planted silent read: a page that reads a table and ignores the error, and one that reads an rpc and draws a zero, are each reported by name; a page that states its failure is not", async () => {
  const planted = (swallow: boolean): SweepPage => ({
    name: "planted",
    draw: async (world: SweepWorld) => {
      const w = world as Any;
      const client = w.db;
      const t = await client.from("user_watchlist").select("id");
      const r = await client.rpc("get_surface_counts", { p_org_id: "o", p_surface: "regulations" });
      const count = (Array.isArray(r.data) ? r.data : []).length;
      return textOf(renderApp(createElement("p", null, swallow ? `${(t.data ?? []).length} watched, ${count} counted` : `${t.error ? "The watchlist could not be loaded. Try again." : `${(t.data ?? []).length} watched`} ${r.error ? "Counts did not load. Retry" : `${count} counted`}`), { path: "/planted" }));
    },
  });
  const silent = await sweepPage(planted(true), memberWorld);
  assert.deepEqual(silent.silent.sort(), ["rpc get_surface_counts", "table user_watchlist"]);
  assert.deepEqual((await sweepPage(planted(false), memberWorld)).silent, []);
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
