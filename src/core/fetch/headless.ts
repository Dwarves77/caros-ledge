// Ported from old_repo/src/lib/sources/canonical-fetch.mjs (lines 60-119)
// The headless tier: Playwright Chromium, usable only where the browser is installed (the Actions runner and the parity gate).
// Elsewhere it returns needsHeadless and the ladder records the exhaustion; nothing metered is ever called.
import { toText } from "./classify-body";
import { type FetchDeps, type TransportResult } from "./direct";
import { assertFetchAllowed } from "./hold";

const NEEDS_HEADLESS = (max: number): TransportResult => ({ status: 0, text: "", truncated: false, fullLength: 0, cap: max, needsHeadless: true });

/** Render `url` in headless Chromium and return its visible text. A missing playwright package or browser is `needsHeadless`, not an error. The hold gate runs first. */
export async function fetchHeadless(url: string, deps: FetchDeps, opts: { max: number; timeoutMs?: number }): Promise<TransportResult> {
  await assertFetchAllowed(url, deps.caller, deps);
  let browser: { newPage(): Promise<{ goto(u: string, o: object): Promise<{ status(): number } | null>; content(): Promise<string>; url(): string }>; close(): Promise<void> } | null = null;
  try {
    const { chromium } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "playwright");
    browser = await chromium.launch({ headless: true });
  } catch {
    return NEEDS_HEADLESS(opts.max);
  }
  try {
    const page = await browser.newPage();
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs ?? 30_000 });
    const full = toText(await page.content());
    return { status: res?.status() ?? 200, text: full.slice(0, opts.max), truncated: full.length > opts.max, fullLength: full.length, cap: opts.max, finalUrl: page.url() };
  } catch {
    return { status: 0, text: "", truncated: false, fullLength: 0, cap: opts.max };
  } finally {
    await browser.close();
  }
}
