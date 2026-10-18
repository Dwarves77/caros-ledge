// Parity capture (PART2-AGENT-PLAN-2026-10-15 section 7). Ported from the old repo's fsi-app/tests/parity/capture.mjs (lane H-2); the same record shape, so compare.mjs reads a baseline and a capture alike.
// Each signed-in route names its account in routes.json (`auth`: "member" | "admin"). A route whose account has no credentials (or with --signed-out-only) is recorded as `skipped`, not failed.
//
// Usage: node tests/parity/capture.mjs --base <origin> --out <dir> [--signed-out-only]
//
// For every route in routes.json, at 1280x900 and 375x812: waits for network idle, writes a full-page PNG and a JSON
// record (accessibility tree, landmarks, headings, interactive controls, first rows with measured heights).
// Each account signs in once through the /login form; its storage state is held in memory only, never written to disk, never printed.
// Admin routes are captured only when PARITY_ADMIN=1 (the deployed preview; the CI runner holds no service-role key). Credentials: member = LIVE_SMOKE_EMAIL / LIVE_SMOKE_PASSWORD, admin = LIVE_ADMIN_EMAIL / LIVE_ADMIN_PASSWORD.
// Exit code is 1 when any sign-in, discovery or capture failed; index.json is written in every case.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 375, height: 812 },
];
const ROW_LIMIT = 20;
// A page that navigates its main frame more often than this after goto is looping (a reload on every auth event, a redirect cycle).
const NAVIGATION_CEILING = 3;
const ACCOUNTS = { member: ['LIVE_SMOKE_EMAIL', 'LIVE_SMOKE_PASSWORD'], admin: ['LIVE_ADMIN_EMAIL', 'LIVE_ADMIN_PASSWORD'] };
const ROUTES_FILE = join(dirname(fileURLToPath(import.meta.url)), 'routes.json');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--signed-out-only') args['signed-out-only'] = true;
    else if (key?.startsWith('--') && argv[i + 1] !== undefined) args[key.slice(2)] = argv[(i += 1)];
    else throw new Error(`usage: capture.mjs --base <origin> --out <dir> [--signed-out-only] [--routes a,b] [--site old] (bad argument ${key ?? '<none>'})`);
  }
  return args;
}

// Resolves after network idle; false when the page never went idle within the budget (recorded, not fatal).
async function settle(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

async function signIn(browser, base, email, password) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(new URL('/login', base).href, { waitUntil: 'load', timeout: 60000 });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60000 });
    await settle(page);
    return await context.storageState();
  } finally {
    await context.close();
  }
}

// The path a route is captured at: `oldPath` (when the route has one) on the old site (--site old), else `path`. One record name either way.
export function pathFor(route, site) {
  return site === "old" && route.oldPath ? route.oldPath : (route.path ?? null);
}

// What a discovery miss means. A list route declared frame-only in approved-changes.json (`gates.frame`) has no detail links yet, so the detail
// route is skipped; a list route in `gates.full`, or one nobody declared, is expected to have links, so a miss is an error.
// A route the baseline has never captured (no files for it in baseline/index.json: the old site had no link to find) cannot fail as if a baseline existed: the miss is reported as skipped, "baseline owed". Once the
// baseline carries files for the route, a miss fails as before. Data-driven and self-retiring, the way an until-migration waiver is.
export function discoveryMissOutcome(route, gates, baselineIndex) {
  if (baselineIndex) {
    const entry = (baselineIndex.routes ?? []).find((r) => r.name === route.name);
    if (!entry || !(entry.files ?? []).length) return { status: 'skipped', error: `baseline owed: ${route.name} not yet captured from the old site` };
  }
  const list = route.discover.list;
  const name = list.replace(/^\//, '').split(/[/?#]/)[0];
  if ((gates.full ?? []).includes(name) || !(gates.frame ?? []).includes(name)) return { status: 'error', error: null };
  return { status: 'skipped', error: `discovery deferred: ${list} is frame-only (gates.frame)` };
}

// Resolves a `discover` route: the first same-origin link on the list page whose pathname matches and is not excluded.
async function discover(page, base, route, gates, baselineIndex) {
  const { list, match, exclude = [] } = route.discover;
  const listUrl = new URL(list, base);
  await page.goto(listUrl.href, { waitUntil: 'load', timeout: 60000 });
  await settle(page);
  const hrefs = await page.$$eval('a[href]', (anchors) => anchors.map((a) => a.getAttribute('href')));
  const pattern = new RegExp(match);
  for (const href of hrefs) {
    if (!href) continue;
    const url = new URL(href, listUrl);
    if (url.origin !== listUrl.origin) continue;
    if (pattern.test(url.pathname) && !exclude.includes(url.pathname)) return `${url.pathname}`;
  }
  const miss = new Error(`discovery found no link on ${list} matching ${match}`);
  miss.outcome = discoveryMissOutcome(route, gates, baselineIndex);
  throw miss;
}

// Runs in the page. Helpers live inside so the whole function serialises as one unit. Exported so the UX smoke records its fixture pages the same way.
export function domSummary(rowLimit) {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const rendered = (el) => el.getClientRects().length > 0;
  const accName = (el) => {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const t = clean(ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
      if (t) return t;
    }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label && clean(label.textContent)) return clean(label.textContent);
    }
    const wrapping = el.closest('label');
    if (wrapping && clean(wrapping.textContent)) return clean(wrapping.textContent);
    return clean(el.textContent) || clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title'));
  };
  const IMPLICIT_LANDMARK = { header: 'banner', nav: 'navigation', main: 'main', footer: 'contentinfo', aside: 'complementary' };
  const INPUT_ROLE = {
    checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button', reset: 'button',
    search: 'searchbox', number: 'spinbutton',
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') return INPUT_ROLE[(el.getAttribute('type') || 'text').toLowerCase()] ?? 'textbox';
    return null;
  };

  const landmarks = [];
  const landmarkSelector = 'header, nav, main, footer, aside, form, section, [role=banner], [role=navigation], [role=main], [role=contentinfo], [role=complementary], [role=region], [role=search], [role=form]';
  for (const el of document.querySelectorAll(landmarkSelector)) {
    if (!rendered(el)) continue;
    const tag = el.tagName.toLowerCase();
    const explicit = el.getAttribute('role');
    const name = accName(el);
    let role = explicit ? explicit.split(/\s+/)[0] : IMPLICIT_LANDMARK[tag];
    if (!role && (tag === 'section' || tag === 'form') && name) role = tag === 'section' ? 'region' : 'form';
    if (!role) continue;
    landmarks.push({ role, name, source: explicit ? 'explicit' : 'implicit' });
  }

  const headings = [];
  for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role=heading]')) {
    if (!rendered(el)) continue;
    const level = el.getAttribute('aria-level') ?? (/^H[1-6]$/.test(el.tagName) ? el.tagName.slice(1) : null);
    headings.push({ level: level === null ? null : Number(level), text: clean(el.textContent) });
  }

  const controls = [];
  const controlSelector = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=checkbox], [role=switch], [role=menuitem], [role=combobox], [role=textbox], [role=option]';
  for (const el of document.querySelectorAll(controlSelector)) {
    if (!rendered(el)) continue;
    const role = roleOf(el);
    if (!role) continue;
    controls.push({ role, name: accName(el) });
  }

  const rows = [];
  const rowSelector = '[data-row], li, tr, article';
  for (const el of document.querySelectorAll(rowSelector)) {
    if (!rendered(el)) continue;
    const box = el.getBoundingClientRect();
    rows.push({ tag: el.tagName.toLowerCase(), text: clean(el.textContent).slice(0, 300), width: box.width, height: box.height });
    if (rows.length === rowLimit) break;
  }

  return {
    landmarks,
    headings,
    controls,
    rows: { selector: rowSelector, limit: rowLimit, items: rows },
    document_height: document.documentElement.scrollHeight,
  };
}

async function accessibilitySnapshot(page) {
  if (typeof page.accessibility?.snapshot === 'function') {
    try {
      return { source: 'page.accessibility.snapshot', tree: await page.accessibility.snapshot() };
    } catch (e) {
      return { source: 'locator.ariaSnapshot', tree: await page.locator('body').ariaSnapshot(), fallbackBecause: String(e?.message ?? e) };
    }
  }
  return { source: 'locator.ariaSnapshot', tree: await page.locator('body').ariaSnapshot() };
}

// `diag` accumulates across both viewports: the first non-2xx response (status and URL without its query string) the main-frame navigation count and the first ten distinct navigated paths.
async function captureOne(browser, base, route, path, viewport, storage, out, diag) {
  const stem = `${route.name}.${viewport.width}x${viewport.height}`;
  const context = await browser.newContext({ viewport, storageState: route.auth ? storage[route.auth] : undefined });
  try {
    const page = await context.newPage();
    const before = diag.navigations;
    const bare = (u) => { const x = new URL(u); return `${x.origin}${x.pathname}`; };
    page.on('response', (r) => {
      if (!diag.firstFailure && (r.status() < 200 || r.status() >= 300)) diag.firstFailure = { status: r.status(), url: bare(r.url()) };
    });
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame()) return;
      diag.navigations += 1;
      const path = bare(f.url());
      if (diag.navigationPaths.length < 10 && !diag.navigationPaths.includes(path)) diag.navigationPaths.push(path);
    });
    const response = await page.goto(new URL(path, base).href, { waitUntil: 'load', timeout: 60000 });
    const networkIdle = await settle(page);
    if (diag.navigations - before > NAVIGATION_CEILING) {
      throw new Error(`navigation loop: ${diag.navigations - before} navigations, paths: ${JSON.stringify(diag.navigationPaths)}`);
    }
    const finalUrl = new URL(page.url());
    await page.screenshot({ path: join(out, `${stem}.png`), fullPage: true });
    const dom = await page.evaluate(domSummary, ROW_LIMIT);
    const accessibility = await accessibilitySnapshot(page);
    const record = {
      route: route.name,
      path,
      auth: route.auth,
      viewport,
      captured_at: new Date().toISOString(),
      http_status: response?.status() ?? null,
      final_path: `${finalUrl.pathname}${finalUrl.search}`,
      network_idle: networkIdle,
      accessibility,
      ...dom,
    };
    await writeFile(join(out, `${stem}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return stem;
  } finally {
    await context.close();
  }
}

function commitOf() {
  if (process.env.GITHUB_SHA) return { commit: process.env.GITHUB_SHA, commit_source: 'GITHUB_SHA' };
  try {
    return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), commit_source: 'git rev-parse HEAD' };
  } catch {
    return { commit: null, commit_source: 'unavailable' };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base || !args.out) throw new Error('usage: capture.mjs --base <origin> --out <dir>');
  const base = new URL(args.base).origin;
  const out = args.out;
  await mkdir(out, { recursive: true });

  const only = args.routes && args.routes !== 'all' ? new Set(args.routes.split(',')) : null;
  const routes = JSON.parse(await readFile(ROUTES_FILE, 'utf8')).routes.filter((r) => !only || only.has(r.name));
  const { gates } = JSON.parse(await readFile(join(dirname(ROUTES_FILE), 'approved-changes.json'), 'utf8'));
  const baselineIndex = JSON.parse(await readFile(join(dirname(ROUTES_FILE), 'baseline', 'index.json'), 'utf8'));
  const index = {
    captured_at: new Date().toISOString(),
    ...commitOf(),
    base,
    viewports: VIEWPORTS.map((v) => `${v.width}x${v.height}`),
    signin: null,
    routes: routes.map((r) => ({ name: r.name, path: pathFor(r, args.site), auth: r.auth, status: 'pending', files: [], error: null, diagnostics: { firstFailure: null, navigations: 0, navigationPaths: [] } })),
  };
  let failed = false;
  const browser = await chromium.launch();
  try {
    // One sign-in per account that has both credentials; `storage[account]` is absent for an account without them or whose sign-in failed.
    const storage = {};
    const credentials = {};
    for (const [account, [emailVar, passwordVar]] of Object.entries(ACCOUNTS)) {
      if (account === 'admin' && process.env.PARITY_ADMIN !== '1') continue;
      if (!args['signed-out-only'] && process.env[emailVar] && process.env[passwordVar]) credentials[account] = [process.env[emailVar], process.env[passwordVar]];
    }
    index.signin = {};
    for (const account of new Set(routes.map((r) => r.auth).filter(Boolean))) {
      if (!credentials[account]) {
        index.signin[account] = 'skipped';
        continue;
      }
      try {
        storage[account] = await signIn(browser, base, ...credentials[account]);
        index.signin[account] = 'ok';
      } catch (err) {
        index.signin[account] = `failed: ${err.message}`;
        failed = true;
        console.log(`sign-in failed (${account}): ${err.message}`);
      }
    }
    // A route whose account has credentials but no state is an error; one whose account has no credentials is skipped.
    const unavailable = (route) => {
      if (!route.auth || storage[route.auth]) return null;
      return credentials[route.auth]
        ? { status: 'error', error: 'not captured: no signed-in state' }
        : { status: 'skipped', error: route.auth === 'admin' && process.env.PARITY_ADMIN !== '1' ? 'admin routes gate on the deployed preview' : `no ${route.auth} credentials` };
    };

    // Discovery runs first so every capture below has its concrete path.
    for (const [i, route] of routes.entries()) {
      const entry = index.routes[i];
      if (!route.discover) continue;
      const missing = unavailable(route);
      if (missing) {
        Object.assign(entry, missing);
        continue;
      }
      const context = await browser.newContext({ viewport: VIEWPORTS[1], storageState: storage[route.auth] });
      try {
        entry.path = await discover(await context.newPage(), base, route, gates, baselineIndex);
      } catch (err) {
        entry.status = err.outcome?.status ?? 'error';
        entry.error = err.outcome?.status === 'skipped' ? err.outcome.error : err.message;
        if (entry.status === 'error') failed = true;
      } finally {
        await context.close();
      }
    }

    for (const [i, route] of routes.entries()) {
      const entry = index.routes[i];
      if (entry.status === 'error' || entry.status === 'skipped') continue;
      const missing = unavailable(route);
      if (missing) {
        Object.assign(entry, missing);
        if (missing.status === 'error') failed = true;
        continue;
      }
      try {
        for (const viewport of VIEWPORTS) {
          entry.files.push(await captureOne(browser, base, route, entry.path, viewport, storage, out, entry.diagnostics));
        }
        entry.status = 'ok';
        console.log(`captured ${route.name}`);
      } catch (err) {
        entry.status = 'error';
        entry.error = err.message;
        failed = true;
        console.log(`capture failed: ${route.name}`);
      }
    }
  } finally {
    await browser.close();
    await writeFile(join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
