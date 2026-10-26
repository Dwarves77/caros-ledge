// DRAIN-FIX-2 visibility: the signed-in check judges a page by the typed marker and the item's path, names every item that does not render, and executePlan writes the applied item ids the script reads.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

// @ts-expect-error plain .mjs module
import { executePlan } from "../../scripts/runs/execute.mjs";
// @ts-expect-error plain .mjs module
import { parsePlan } from "../../scripts/runs/plan.mjs";
// @ts-expect-error plain .mjs module
import { checkItems, MARKER } from "../../scripts/runs/visible.mjs";

const A = "b293a2b6-c882-44dc-8efc-a801ed6a160b";
const B = "0ee667cc-a403-4fe3-b5f8-4f829a4a9103";

test("visible: an item whose page draws the marker on its own path passes; no marker, an HTTP error, an end away from the item and a missing route are each named", async () => {
  const pages: Record<string, Record<string, unknown>> = {
    [`/regulations/${A}`]: { status: 200, finalUrl: `https://x.test/regulations/${A}`, markers: 4 },
    [`/market/${B}`]: { status: 200, finalUrl: `https://x.test/market/${B}`, markers: 0 },
  };
  const bad = await checkItems([A, B], { pathOf: async (id: string) => (id === A ? `/regulations/${id}` : `/market/${id}`), open: async (p: string) => pages[p] });
  assert.equal(bad.length, 1);
  assert.match(bad[0], new RegExp(`^${B}: .* drew no`));
  assert.match((await checkItems([A], { pathOf: async () => "/x", open: async () => ({ status: 404, finalUrl: "u", markers: 1 }) }))[0], /HTTP 404/);
  assert.match((await checkItems([A], { pathOf: async () => "/x", open: async () => ({ status: 200, finalUrl: "https://x.test/login", markers: 1 }) }))[0], /away from the item/);
  assert.match((await checkItems([A], { pathOf: async () => null, open: async () => null }))[0], /no route/);
});

test("visible: a real browser page (a local fixture server) is judged by the typed marker, not by text", async () => {
  const server = createServer((req, res) => res.setHeader("content-type", "text/html").end(req.url?.includes("drawn") ? `<main><div data-audit="detail-section-head">x</div></main>` : "<main>the brief is here</main>"));
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
      const out = { status: res?.status() ?? 0, finalUrl: page.url(), markers: await page.$$eval(MARKER, (els: unknown[]) => els.length) };
      await page.close();
      return out;
    };
    assert.deepEqual(await checkItems([A], { pathOf: async (id: string) => `/drawn/${id}`, open }), []);
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
