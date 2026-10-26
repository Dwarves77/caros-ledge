// DRAIN-FIX-2 visibility: the signed-in check judges a page by the typed marker and the item's path, names every item that does not render, and executePlan writes the applied item ids the script reads.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

// @ts-expect-error plain .mjs module
import { executePlan } from "../../scripts/runs/execute.mjs";
// @ts-expect-error plain .mjs module
import { parsePlan } from "../../scripts/runs/plan.mjs";
// @ts-expect-error plain .mjs module
import { checkItems, ITEM_ATTR, MARKER } from "../../scripts/runs/visible.mjs";

const A = "b293a2b6-c882-44dc-8efc-a801ed6a160b";
const B = "0ee667cc-a403-4fe3-b5f8-4f829a4a9103";

test("visible: an item whose page draws the marker on its own path passes; no marker, an HTTP error, a different item on the page, no item attribute and a missing route are each named", async () => {
  const pages: Record<string, Record<string, unknown>> = {
    [`/regulations/${A}`]: { status: 200, finalUrl: `https://x.test/regulations/${A}`, markers: 4, itemId: A },
    [`/market/${B}`]: { status: 200, finalUrl: `https://x.test/market/${B}`, markers: 0 },
  };
  const bad = await checkItems([A, B], { pathOf: async (id: string) => (id === A ? `/regulations/${id}` : `/market/${id}`), open: async (p: string) => pages[p] });
  assert.equal(bad.length, 1);
  assert.match(bad[0], new RegExp(`^${B}: .* drew no`));
  assert.match((await checkItems([A], { pathOf: async () => "/x", open: async () => ({ status: 404, finalUrl: "u", markers: 1 }) }))[0], /HTTP 404/);
  // a uuid URL redirects to the item's slug: the landing URL is information, the typed data-item-id decides
  const landed: string[] = [];
  assert.deepEqual(await checkItems([A], { landed, pathOf: async () => "/x", open: async () => ({ status: 200, finalUrl: "https://x.test/regulations/g19", markers: 3, itemId: A }) }), []);
  assert.deepEqual(landed, [`${A} -> https://x.test/regulations/g19`]);
  assert.match((await checkItems([A], { pathOf: async () => "/x", open: async () => ({ status: 200, finalUrl: "https://x.test/regulations/g19", markers: 3, itemId: B }) }))[0], new RegExp(`shows item ${B}, not the item`));
  assert.match((await checkItems([A], { pathOf: async () => "/x", open: async () => ({ status: 200, finalUrl: "https://x.test/regulations/g19", markers: 3, itemId: null }) }))[0], /no data-item-id/);
  assert.match((await checkItems([A], { pathOf: async () => "/x", open: async () => ({ status: 200, finalUrl: "https://x.test/login", markers: 0, itemId: null }) }))[0], /drew no/);
  assert.match((await checkItems([A], { pathOf: async () => null, open: async () => null }))[0], /no route/);
  // no item type is read: the item is tried on each surface and passes when one renders
  const tries: string[] = [];
  const multi = await checkItems([A], { pathOf: async (id: string) => [`/market/${id}`, `/regulations/${id}`], open: async (p: string) => (tries.push(p), p.startsWith("/regulations") ? { status: 200, finalUrl: `https://x.test${p}`, markers: 2, itemId: A } : { status: 404, finalUrl: `https://x.test${p}`, markers: 0 }) });
  assert.deepEqual([multi, tries.length], [[], 2]);
});

test("visible: a real browser page (a local fixture server) is judged by the typed marker, not by text", async () => {
  const server = createServer((req, res) => {
    const u = req.url ?? "";
    if (u.startsWith("/go/")) return void res.writeHead(302, { location: `/slug/${u.split("/")[2]}` }).end();
    res.setHeader("content-type", "text/html").end(u.startsWith("/slug/") ? `<main data-item-id="${u.includes("other") ? B : A}"><div data-audit="detail-section-head">x</div></main>` : u.includes("noattr") ? `<main><div data-audit="detail-section-head">x</div></main>` : "<main>the brief is here</main>");
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let browser;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch {
    server.close();
    return; // no browser on this machine: the pure judgement above is the proof
  }
  try {
    const context = await browser.newContext();
    const open = async (path: string) => {
      const page = await context.newPage();
      const res = await page.goto(`${base}${path}`);
      const out = { status: res?.status() ?? 0, finalUrl: page.url(), markers: await page.$$eval(MARKER, (els: unknown[]) => els.length), itemId: await page.$eval(`[${ITEM_ATTR}]`, (el: Element, a: string) => el.getAttribute(a), ITEM_ATTR).catch(() => null) };
      await page.close();
      return out;
    };
    assert.deepEqual(await checkItems([A], { pathOf: async (id: string) => `/go/${id}`, open }), [], "redirected to a slug, marker and the right data-item-id: passes");
    assert.equal((await checkItems([A], { pathOf: async () => `/go/other`, open })).length, 1, "a different data-item-id fails");
    assert.equal((await checkItems([A], { pathOf: async () => `/noattr`, open })).length, 1, "the marker without the item attribute fails");
    assert.equal((await checkItems([A], { pathOf: async (id: string) => `/plain/${id}`, open })).length, 1, "the words of the brief without the marker do not pass");
  } finally {
    await browser.close();
    server.close();
  }
});

test("visible: executePlan writes the item ids an item-briefs step applied or found already applied into the results", async () => {
  const plan = parsePlan(JSON.stringify({ ruling: "r", steps: [{ name: "items", stage: "briefs", mode: "apply", input: { briefs: { batch: { kind: "item-briefs", content: "{}" } } }, producer_env: [], allow_partial: true }] }));
  const invoke = () => ({ status: 0, result: { root_run_id: "r", runs: [{ family: "brief-apply", id: "x", mode: "apply", outcome: "partial", counts: {}, ids: { applied_ids: [A], already_applied_ids: [B] } }] } });
  const r = await executePlan(plan, "scripts/runs/plans/2026-10-27-x.json", { invoke, now: () => new Date("2026-10-27T00:00:00Z") });
  assert.deepEqual(r.applied_item_ids.sort(), [B, A].sort());
});
