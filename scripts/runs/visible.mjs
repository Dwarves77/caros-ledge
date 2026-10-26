// DRAIN-FIX-2 / VISIBLE-FIX-1 visibility: `node scripts/runs/visible.mjs <results.json> --base <origin>` loads the detail page of every item a ruled run applied (results.applied_item_ids, written by scripts/runs/execute.mjs) as the signed-in member
// and asserts the page it lands on, after any redirect, drew the brief (the typed marker data-audit="detail-section-head" at least once) AND states the item it shows (the typed attribute data-item-id on the detail root, src/ui/detail/DetailShell.tsx).
// A uuid URL redirects to the item's legacy slug (src/core/detail/id-redirect.ts), so the URL is reported as information, never judged. No page text is matched (ADR-053). Exit 1 names every item that does not render; 2 when a
// credential is missing. The sign-in is the capture's own (tests/parity/capture.mjs signIn: LIVE_SMOKE_EMAIL and LIVE_SMOKE_PASSWORD from the environment, never typed),. The item type is not read from the database: the item is tried on each surface route and passes when one renders (the runner holds no service key).
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { parseArgs } from "node:util";

import { isMain } from "../lib/fs.mjs";

export const MARKER = '[data-audit="detail-section-head"]';
export const ITEM_ATTR = "data-item-id";

/** The finding for one opened page, or null when the page drew the brief and states the item. The final URL is information only. Pure. */
export function finding(id, path, page) {
  if (!page || page.error) return `${id}: ${path} did not load (${page?.error ?? "no response"})`;
  if (page.status >= 400) return `${id}: ${path} answered HTTP ${page.status}`;
  if (!(page.markers > 0)) return `${id}: ${path} (ended at ${page.finalUrl}) drew no ${MARKER}: the brief is not shown`;
  return page.itemId === id ? null : `${id}: ${path} (ended at ${page.finalUrl}) shows ${page.itemId ? `item ${page.itemId}` : `no ${ITEM_ATTR}`}, not the item`;
}

/** Every applied item opened through `open(path)` (a signed-in page loader) and judged; `pathOf(id)` is the item's route or the list of routes it may have (one per surface: the item passes when any renders). Returns the findings (empty: all rendered). */
export async function checkItems(ids, { open, pathOf, landed = [] }) {
  const out = [];
  for (const id of ids) {
    const paths = [await pathOf(id)].flat().filter(Boolean);
    const found = [];
    for (const path of paths) {
      const page = await open(path);
      const f = finding(id, path, page);
      if (!f) {
        if (page?.finalUrl) landed.push(`${id} -> ${page.finalUrl}`);
        found.length = 0;
        break;
      }
      found.push(f);
    }
    if (!paths.length) out.push(`${id}: no route for the item`);
    else out.push(...found);
  }
  return out;
}

if (isMain(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { base: { type: "string" } } });
  const ids = JSON.parse(readFileSync(positionals[0], "utf8")).applied_item_ids ?? [];
  const env = process.env;
  const need = ["LIVE_SMOKE_EMAIL", "LIVE_SMOKE_PASSWORD"].filter((n) => !env[n]);
  if (!values.base || need.length) {
    console.error(`visible: missing ${[!values.base && "--base", ...need].filter(Boolean).join(", ")}`);
    process.exit(2);
  }
  register("../lib/ts-hooks.mjs", import.meta.url, { data: {} });
  const { SURFACE_PATH } = await import("../../src/core/routing/index.ts");
  const { chromium } = await import("playwright");
  const { signIn } = await import("../../tests/parity/capture.mjs");
  const { installBypass } = await import("../ci/live/bypass.mjs");
  const browser = await chromium.launch();
  try {
    const state = await signIn(browser, values.base, env.LIVE_SMOKE_EMAIL, env.LIVE_SMOKE_PASSWORD);
    const context = await browser.newContext({ storageState: state });
    await installBypass(context, values.base);
    const landed = [];
    const bad = await checkItems(ids, {
      landed,
      pathOf: (id) => Object.values(SURFACE_PATH).map((base) => `${base}/${encodeURIComponent(id)}`),
      open: async (path) => {
        const page = await context.newPage();
        try {
          const res = await page.goto(new URL(path, values.base).href, { waitUntil: "load", timeout: 60000 });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          return { status: res?.status() ?? 0, finalUrl: page.url(), markers: await page.$$eval(MARKER, (els) => els.length), itemId: await page.$eval(`[${ITEM_ATTR}]`, (el, a) => el.getAttribute(a), ITEM_ATTR).catch(() => null) };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        } finally {
          await page.close();
        }
      },
    });
    console.log(`visible: ${ids.length} item(s), ${bad.length} not rendering`);
    for (const l of landed) console.log(`visible: landed ${l}`);
    for (const b of bad) console.error(`visible: ${b}`);
    process.exitCode = bad.length ? 1 : 0;
  } finally {
    await browser.close();
  }
}
