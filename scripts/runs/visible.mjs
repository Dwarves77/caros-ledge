// DRAIN-FIX-2 visibility: `node scripts/runs/visible.mjs <results.json> --base <origin>` loads the detail page of every item a ruled run applied (results.applied_item_ids, written by scripts/runs/execute.mjs) as the signed-in member
// and asserts the page drew the brief: the typed DOM marker data-audit="detail-section-head" at least once, on the item's own path. No page text is matched (ADR-053). Exit 1 names every item that does not render; 2 when a
// credential is missing. The sign-in is the capture's own (tests/parity/capture.mjs signIn: LIVE_SMOKE_EMAIL and LIVE_SMOKE_PASSWORD from the environment, never typed), and the item's route is read with the service key.
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { parseArgs } from "node:util";

import { isMain } from "../lib/fs.mjs";

export const MARKER = '[data-audit="detail-section-head"]';

/** The finding for one opened page, or null when the brief rendered. Pure. */
export function finding(id, path, page) {
  if (!page || page.error) return `${id}: ${path} did not load (${page?.error ?? "no response"})`;
  if (page.status >= 400) return `${id}: ${path} answered HTTP ${page.status}`;
  if (!page.finalUrl.includes(id)) return `${id}: ${path} ended at ${page.finalUrl}, away from the item`;
  return page.markers > 0 ? null : `${id}: ${path} drew no ${MARKER}: the brief is not shown`;
}

/** Every applied item opened through `open(path)` (a signed-in page loader) and judged; `pathOf(id)` is the item's route. Returns the findings (empty: all rendered). */
export async function checkItems(ids, { open, pathOf }) {
  const out = [];
  for (const id of ids) {
    const path = await pathOf(id);
    const f = path ? finding(id, path, await open(path)) : `${id}: no route for the item`;
    if (f) out.push(f);
  }
  return out;
}

if (isMain(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { base: { type: "string" } } });
  const ids = JSON.parse(readFileSync(positionals[0], "utf8")).applied_item_ids ?? [];
  const env = process.env;
  const need = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "LIVE_SMOKE_EMAIL", "LIVE_SMOKE_PASSWORD"].filter((n) => !env[n]);
  if (!values.base || need.length) {
    console.error(`visible: missing ${[!values.base && "--base", ...need].filter(Boolean).join(", ")}`);
    process.exit(2);
  }
  register("../lib/ts-hooks.mjs", import.meta.url, { data: {} });
  const { serviceClient } = await import("../../src/core/db/index.ts");
  const { surfaceHref, surfaceOf } = await import("../../src/core/routing/index.ts");
  const { chromium } = await import("playwright");
  const { signIn } = await import("../../tests/parity/capture.mjs");
  const { installBypass } = await import("../ci/live/bypass.mjs");
  const sb = serviceClient();
  const browser = await chromium.launch();
  try {
    const state = await signIn(browser, values.base, env.LIVE_SMOKE_EMAIL, env.LIVE_SMOKE_PASSWORD);
    const context = await browser.newContext({ storageState: state });
    await installBypass(context, values.base);
    const bad = await checkItems(ids, {
      pathOf: async (id) => {
        const { data } = await sb.from("intelligence_items").select("item_type, domain").eq("id", id).maybeSingle();
        return data ? surfaceHref(surfaceOf(data.item_type, data.domain), id) : null;
      },
      open: async (path) => {
        const page = await context.newPage();
        try {
          const res = await page.goto(new URL(path, values.base).href, { waitUntil: "load", timeout: 60000 });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          return { status: res?.status() ?? 0, finalUrl: page.url(), markers: await page.$$eval(MARKER, (els) => els.length) };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        } finally {
          await page.close();
        }
      },
    });
    console.log(`visible: ${ids.length} item(s), ${bad.length} not rendering`);
    for (const b of bad) console.error(`visible: ${b}`);
    process.exitCode = bad.length ? 1 : 0;
  } finally {
    await browser.close();
  }
}
