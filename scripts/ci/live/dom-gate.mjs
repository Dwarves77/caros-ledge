// LIVE-GATE-1: the signed-in production DOM gate. It loads the five list pages and the first detail of each as the signed-in account (a storage state minted by scripts/ci/live-session.mjs), reduces what a reader sees to `facts`,
// and judges the facts against tests/live/assertions.json. Each assertion has an id, an owner lane and `armed`: an armed failure is red, an unarmed one is printed NOT-ARMED with what the run saw. Pure judging (`gateResults`) is
// separate from the browser work (`collectFacts`), so each assertion is tried against fixture facts (tests/ci/live-gate.test.mjs). No page text is classified: the tests are typed markers, counts, and the patterns of ids that must never reach a reader.
import { readFileSync } from "node:fs";

import { loadPage } from "./load.mjs";

export const LIST_PAGES = ["/", "/regulations", "/market", "/operations", "/research"];
export const ASSERTIONS_FILE = new URL("../../../tests/live/assertions.json", import.meta.url);
export const loadAssertions = (file = ASSERTIONS_FILE) => JSON.parse(readFileSync(file, "utf8")).assertions;

/** Runs in the page: what the gate needs of one settled DOM. `text` is what a reader sees; connection entries read textContent so a closed disclosure still counts. */
export const domFacts = () => {
  const words = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
  const all = (s, root = document) => [...root.querySelectorAll(s)];
  const radar = document.querySelector('[data-audit="flywheel-radar"]');
  const ribbon = document.querySelector('[data-audit="headline-series"]');
  const board = document.querySelector('[data-audit="market-series-board"]');
  return {
    text: document.body.innerText,
    accountMenu: Boolean(document.querySelector('[aria-label="Open account menu"]')),
    title: words(all("h1").at(-1)),
    rows: all('[data-part="list-row"]').map((r) => ({ title: words(r.querySelector(".cl-row-title")), why: words(r.querySelector(".cl-row-summary")), href: r.querySelector("a.cl-row-link")?.getAttribute("href") ?? null })),
    connections: all('[data-part="item-connections"] .cl-detail-link').map((a) => ({ label: words(a.querySelector(".cl-detail-label")), title: words(a.querySelector(".cl-detail-link-title")), reason: words(a.querySelector(".cl-detail-link-context")) })),
    triggers: all(".cl-trigger-row .cl-trigger-text").map(words),
    ribbon: ribbon ? { caption: words(ribbon.querySelector('[class*="hCaption"]')), cards: all('[data-audit="headline-card"]', ribbon).map((c) => words(c.querySelector('[data-audit="headline-card-label"] span'))) } : null,
    board: board ? { rows: all('[class*="seriesRow"]', board).map((r) => ({ hasLatest: !r.querySelector('[class*="seriesValue"]')?.hasAttribute("title") })), unregistered: Number(/(\d+) series from a source not yet listed/.exec(board.innerText)?.[1] ?? 0) } : null,
    radar: radar ? { text: words(radar), links: all("a", radar).length, absence: Boolean(radar.querySelector('[data-part="absence"], [data-part="state-note"]')) } : null,
  };
};

const pathOf = (u) => new URL(u, "https://x.invalid").pathname;
const noQuery = (href) => href.split("?")[0];
const RAW = [
  ["a uuid", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi],
  ["a '· 0.xx' score", /·\s*0\.\d{2}\b/g],
  ["a pattern_ method id", /\bpattern_[a-z0-9_]+/gi],
  ["a _gap token", /\b[a-z0-9]+_gap\b/gi],
  ["a corridor token", /\b[A-Z]{5}-[A-Z]{5}:[a-z]+\b/g],
];
/** A metric or method token (ghg_intensity) in what the radar draws: its entity lines name things in words. */
const SNAKE = /\b[a-z]+_[a-z_]+\b/g;
const PENDING = /Narrative synthesis pending|Stale: this synthesis/;
const INSTRUMENT = /\b\d{1,4}\/\d{1,4}\b/;
const CAPTION = /^(\d+) famil(?:y|ies) from (\d+) series/;
/** The line toListRowFields composes when a regulation has no reader text (src/core/lists/row-fields.ts). */
const FALLBACK = /^Applies (in [A-Z]{2}|across jurisdictions)(; next date .*)?\.$/;
const WORDS = (s) => s.split(/\s+/).filter(Boolean).length;
const pages = (facts) => [...facts.lists, ...facts.details];
/** A page the gate did not read (it errored, or ended on the sign-in page) or no page at all: an assertion over it would pass vacuously, so each one reports it as a violation. */
const unread = (list, what) => (list.length === 0 ? [`no ${what} was read`] : list.filter((p) => !p.facts || pathOf(p.finalUrl).startsWith("/login")).map((p) => `${p.path}: not read (${p.error ?? "ended on /login"})`));
const SHOW = 4;
const some = (list) => (list.length > SHOW ? [...list.slice(0, SHOW), `... and ${list.length - SHOW} more`] : list);

/** The violations of each assertion over the facts: id -> list of lines (empty: it passes). Pure. */
export const EVALUATORS = {
  "signed-in": (f) => f.lists.flatMap((p) => (p.error ? [`${p.path}: did not load (${p.error})`] : pathOf(p.finalUrl).startsWith("/login") ? [`${p.path}: ended on /login, no session`] : p.facts?.accountMenu ? [] : [`${p.path}: no account menu drawn`])),
  "no-404": (f) => [
    ...(f.links.length ? [] : ["no detail link was found on the five lists"]),
    ...f.links.filter((l) => l.status === 404 || l.status === 0 || l.status >= 500 || pathOf(l.finalUrl).startsWith("/login")).map((l) => `${l.href}: ${pathOf(l.finalUrl).startsWith("/login") && l.status < 400 ? "ended on /login" : `HTTP ${l.status}`} (linked from ${l.from})`),
  ],
  "no-raw-ids": (f) => [...unread(f.lists, "list page"), ...unread(f.details, "detail page"), ...pages(f).flatMap((p) => RAW.flatMap(([what, re]) => [...new Set((p.facts?.text ?? "").match(re) ?? [])].map((m) => `${p.path}: shows ${what}: ${m}`)).concat([...new Set((p.facts?.radar?.text ?? "").match(SNAKE) ?? [])].map((m) => `${p.path}: the radar shows a snake_case token: ${m}`)))],
  "rows-have-why": (f) => [
    ...unread(f.lists, "list page"),
    ...f.lists.flatMap((p) => {
      const rows = p.facts?.rows ?? [];
      const bare = rows.filter((r) => !r.why);
      return p.facts && rows.length === 0 ? [`${p.path}: draws no rows`] : bare.length ? [`${p.path}: ${bare.length} of ${rows.length} row(s) have no second line, e.g. ${some(bare.map((r) => `"${r.title.slice(0, 60)}"`)).join("; ")}`] : [];
    }),
  ],
  "no-fallback-summary": (f) => {
    const page = f.lists.find((p) => p.path === "/regulations");
    if (!page?.facts) return [`/regulations: not read (${page?.error ?? "no page"})`];
    const fallback = page.facts.rows.filter((r) => FALLBACK.test(r.why));
    return fallback.length ? [`/regulations: ${fallback.length} of ${page.facts.rows.length} row(s) draw the composed fallback, not a reader's text, e.g. ${some(fallback.map((r) => `"${r.title.slice(0, 60)}"`)).join("; ")}`] : [];
  },
  "connections-have-reason": (f) => [...unread(f.details, "detail page"), ...f.details.flatMap((p) => (p.facts?.connections ?? []).filter((c) => WORDS(c.reason) < 3).map((c) => `${p.path}: "${c.title.slice(0, 50)}" (${c.label || "connection"}) renders ${c.reason ? `"${c.reason}"` : "no reason"}`))],
  "reasons-are-pairwise": (f) => [
    ...unread(f.details, "detail page"),
    ...f.details.flatMap((p) => {
      const tally = new Map();
      for (const c of p.facts?.connections ?? []) if (c.reason) tally.set(c.reason, (tally.get(c.reason) ?? 0) + 1);
      return [...tally].filter(([, n]) => n >= 3).map(([reason, n]) => `${p.path}: ${n} connections carry the same reason "${reason.slice(0, 80)}"`);
    }),
  ],
  "no-pending-text": (f) => [...unread(f.lists, "list page"), ...unread(f.details, "detail page"), ...pages(f).filter((p) => PENDING.test(p.facts?.text ?? "")).map((p) => `${p.path}: shows ${PENDING.exec(p.facts.text)[0]}`)],
  "own-mandates": (f) => [
    ...unread(f.details, "detail page"),
    ...f.details.flatMap((p) => {
      const triggers = p.facts?.triggers ?? [];
      if (!triggers.length) return [];
      const number = INSTRUMENT.exec(p.facts.title)?.[0];
      if (!number) return [`${p.path}: ${triggers.length} pending trigger(s) but the title names no instrument number to show they are its own`];
      const foreign = triggers.filter((t) => !t.includes(number));
      return foreign.length ? [`${p.path}: ${foreign.length} of ${triggers.length} trigger(s) do not cite ${number}, e.g. "${foreign[0].slice(0, 80)}"`] : [];
    }),
  ],
  "scoped-grid": (f, params) => {
    const us = f.scoped;
    if (!us?.profile) return [`/operations: no ${params.region} profile reachable from the matrix${us?.reason ? ` (${us.reason})` : ""}`];
    const seen = `${us.panel}
${us.profile.facts?.text ?? ""}`.toLowerCase();
    return [...unread([us.profile], `${params.region} profile`), ...params.forbidden.filter((w) => seen.includes(w.toLowerCase())).map((w) => `${us.profile.path}: the ${params.region} profile shows "${w}"`)];
  },
  "ribbon-complete": (f) => {
    const ribbon = f.lists.find((p) => p.path === "/market")?.facts?.ribbon;
    const board = f.series?.facts?.board;
    if (!ribbon) return ["/market: no headline ribbon drawn"];
    if (!board) return [`/market/series: no series board read${f.series?.error ? ` (${f.series.error})` : ""}`];
    const said = CAPTION.exec(ribbon.caption);
    if (!said) return [`/market: the ribbon's "N families from M series" line was not found, read "${ribbon.caption.slice(0, 80)}"`];
    const [families, series] = [Number(said[1]), Number(said[2])];
    const members = ribbon.cards.reduce((n, label) => n + 1 + Number(/^\+(\d+)/.exec(label)?.[1] ?? 0), 0);
    const latest = board.rows.filter((r) => r.hasLatest).length;
    return [
      ...(families === ribbon.cards.length ? [] : [`/market: the ribbon says ${families} families but draws ${ribbon.cards.length} card(s)`]),
      ...(members >= latest && members <= latest + board.unregistered ? [] : [`/market: the ${ribbon.cards.length} card(s) hold ${members} series (${families} families) but the series board holds ${latest} series with a latest value${board.unregistered ? ` plus ${board.unregistered} not yet listed` : ""}: a series with a latest value is always a headline card`]),
      ...(series >= members && series === board.rows.length + board.unregistered ? [] : [`/market: the ribbon says ${series} series but the series board lists ${board.rows.length + board.unregistered}`]),
    ];
  },
  "radar-present": (f) => {
    const home = f.lists.find((p) => p.path === "/");
    const radar = home?.facts?.radar;
    return !home?.facts ? ["/: not read"] : !radar ? ["/: no flywheel radar section drawn"] : radar.links >= 1 || radar.absence ? [] : ["/: the flywheel radar section holds neither an item nor an absence statement"];
  },
};

/** One row per assertion: PASS or FAIL when armed; NOT-ARMED (with what the run saw) when not. `failed` is true only for an armed failure. Throws on an assertion with no evaluator, so a JSON entry cannot be a silent no-op. */
export function gateResults(facts, assertions = loadAssertions()) {
  return assertions.map((a) => {
    const judge = EVALUATORS[a.id];
    if (!judge) throw new Error(`assertion ${a.id} has no evaluator in scripts/ci/live/dom-gate.mjs`);
    const violations = judge(facts, a.params ?? {});
    const status = a.armed ? (violations.length ? "FAIL" : "PASS") : "NOT-ARMED";
    return { id: a.id, owner: a.owner, armed: Boolean(a.armed), status, saw: violations.length ? "FAIL" : "PASS", violations, failed: a.armed && violations.length > 0 };
  });
}

/** The table a run prints: one line per assertion, then the violations of each assertion that has any. */
export function formatTable(results) {
  const lines = results.map((r) => `  ${r.status.padEnd(9)} ${r.id.padEnd(24)} ${r.armed ? "" : `(would ${r.saw === "PASS" ? "PASS" : `FAIL, ${r.violations.length}`}; owner ${r.owner})`}`.trimEnd());
  const detail = results.filter((r) => r.violations.length).flatMap((r) => [`  ${r.status === "FAIL" ? "FAIL" : "not armed"} ${r.id}:`, ...some(r.violations).map((v) => `    ${v}`)]);
  return ["signed-in DOM gate:", ...lines, ...detail].join("\n");
}

/** The links on the lists: each distinct detail path once, with the list page it was first seen on. */
export const linksOf = (lists) => {
  const seen = new Map();
  for (const p of lists) for (const r of p.facts?.rows ?? []) if (r.href && !seen.has(noQuery(r.href))) seen.set(noQuery(r.href), { href: r.href, from: p.path });
  return [...seen.values()];
};

/** A detail link answered through the context's cookies (no page script runs): status and where it ended; the one 429 is waited out as everywhere else. */
async function probe(context, base, link, headers, sleep) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await context.request.get(new URL(link.href, base).href, { headers, timeout: 60000 });
      if (res.status() === 429 && attempt === 0) {
        await sleep(Math.min(Number(res.headers()["retry-after"] ?? 30), 65) * 1000);
        continue;
      }
      return { ...link, status: res.status(), finalUrl: res.url() };
    } catch (e) {
      return { ...link, status: 0, finalUrl: base, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** The region's profile as the operations matrix opens it: the first sourced cell of the region's column, its panel text and its "Open profile" link, then that profile's page. */
async function scopedProfile(context, base, region) {
  const page = await context.newPage();
  try {
    await page.goto(`${base}/operations`, { waitUntil: "load", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    const cells = await page.$$(`td[role="gridcell"][aria-label^="${region},"]`);
    for (const cell of cells) {
      if (/no sourced fact/.test((await cell.getAttribute("aria-label")) ?? "")) continue;
      await cell.click();
      const panel = page.locator('[data-audit="ops-matrix-panel"]');
      const href = await panel.locator("a").first().getAttribute("href", { timeout: 3000 }).catch(() => null);
      if (!href) continue;
      return { panel: await panel.innerText(), profile: { path: pathOf(href), ...(await loadPage(context, base, href, { extract: domFacts })) } };
    }
    return { reason: cells.length ? `no ${region} cell opens a profile` : `no ${region} column in the matrix` };
  } finally {
    await page.close();
  }
}

/** The facts of one run: the five lists, every distinct detail link probed, the first detail of each list, the series board the market ribbon links to, and the scoped profile. A page that cannot load is a fact ({ error }), never a throw. */
export async function collectFacts(context, base, { headers = {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, assertions = loadAssertions() } = {}) {
  const lists = [];
  for (const path of LIST_PAGES) lists.push({ path, ...(await loadPage(context, base, path, { extract: domFacts })) });
  const links = [];
  for (const l of linksOf(lists)) links.push(await probe(context, base, l, headers, sleep));
  const details = [];
  for (const p of lists) {
    const first = p.facts?.rows.find((r) => r.href);
    if (first) details.push({ path: pathOf(first.href), ...(await loadPage(context, base, first.href, { extract: domFacts })) });
  }
  const series = { path: "/market/series", ...(await loadPage(context, base, "/market/series", { extract: domFacts })) };
  const scoped = await scopedProfile(context, base, assertions.find((a) => a.id === "scoped-grid")?.params.region ?? "United States").catch((e) => ({ reason: e instanceof Error ? e.message : String(e) }));
  log(`signed-in DOM gate: ${lists.length} list(s), ${links.length} detail link(s) probed, ${details.length} detail(s) read`);
  return { lists, links, details, series, scoped };
}
