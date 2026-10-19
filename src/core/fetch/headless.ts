// Ported from old_repo/src/lib/sources/canonical-fetch.mjs (lines 60-119)
// The browser tier (R2c addendum B): headless Chromium on the Actions runner, with its own real browser identity (no user-agent override, no changed fingerprint), reading a page the way a person's browser would, at a human pace.
// It runs only where a person could: robots.txt allows the URL (or the host publishes none), the source is not paywalled, the page shows no login or paywall gate, no CAPTCHA or other interactive challenge is presented (it is
// recorded and the ladder moves on; this tier never solves, clicks through or waits one out), and one navigation per host goes at most every 3 to 5 seconds, serialised per host. Elsewhere (off the runner, no browser installed)
// it returns needsHeadless and the ladder records the exhaustion; nothing metered is ever called.
import { BODY_CLASS, detectAccessWall, INTERACTIVE_CHALLENGE_RE, toText, WALL_MAX_CHARS } from "./classify-body";
import { type FetchDeps, type TransportResult } from "./direct";
import { decodeEntities, stripTags } from "./entities";
import { assertFetchAllowed } from "./hold";
import { robotsGateFor } from "./honest";
import { documentLanguage, type RefusalReason } from "./policy";
import { interpretRobotsAnswer, verdictFor, type RobotsVerdict } from "./robots";

export const BROWSER_PACE_MS = { min: 3000, max: 5000 } as const;
export interface PageLike {
  goto(url: string, opts: { waitUntil: "networkidle"; timeout: number }): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  url(): string;
  waitForTimeout(ms: number): Promise<void>;
  close(): Promise<void>;
}
export interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
export interface BrowserLike {
  newContext(): Promise<BrowserContextLike>;
  close(): Promise<void>;
}
export interface BrowserDeps extends FetchDeps {
  /** Launch the browser; null means Playwright's Chromium, and only on the Actions runner. A test supplies a stand-in. */
  launchBrowser: (() => Promise<BrowserLike>) | null;
}
export interface BrowserCtx {
  /** The source row is flagged paywalled: this tier never runs on it. */
  paywalled?: boolean;
  timeoutMs?: number;
}
interface Session {
  browser: BrowserLike | null;
  contexts: Map<string, BrowserContextLike>;
  lastAt: Map<string, number>;
  turns: Map<string, Promise<unknown>>;
}
const sessions = new WeakMap<object, Session>();
const sessionOf = (deps: object): Session => {
  let s = sessions.get(deps);
  if (!s) sessions.set(deps, (s = { browser: null, contexts: new Map(), lastAt: new Map(), turns: new Map() }));
  return s;
};

const result = (max: number, status: number, extra: Partial<TransportResult> = {}): TransportResult => ({ status, text: "", truncated: false, fullLength: 0, cap: max, ...extra });
const refused = (max: number, reason: RefusalReason, transient: boolean, detail: string, rule?: string): TransportResult =>
  result(max, 0, { refusal: { ok: false, reason, transient, status: null, contentType: "", finalUrl: null, pdfBytes: null, detail, ...(rule ? { rule } : {}) } });
/** Is the failure the browser being absent (not installed, no package), as opposed to a launch that broke? */
const isAbsent = (e: unknown): boolean => /Cannot find (?:module|package)|MODULE_NOT_FOUND|Executable doesn't exist|browserType\.launch: .*(?:not found|install)/i.test(e instanceof Error ? `${e.message} ${String((e as { code?: unknown }).code ?? "")}` : String(e));

async function browserOf(deps: BrowserDeps, s: Session): Promise<BrowserLike> {
  if (s.browser) return s.browser;
  if (deps.launchBrowser) return (s.browser = await deps.launchBrowser());
  const { chromium } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "playwright");
  return (s.browser = (await chromium.launch({ headless: true })) as unknown as BrowserLike);
}

/** Close the run's browser and its per-host contexts. The caller that fetched calls it once at the end of the run. */
export async function closeBrowser(deps: object): Promise<void> {
  const s = sessions.get(deps);
  if (!s) return;
  sessions.delete(deps);
  for (const c of s.contexts.values()) await c.close();
  await s.browser?.close();
}

/** The wait before a host's next navigation: 3 to 5 seconds, a spread that varies by host and by turn without a source of randomness (so a run is reproducible from its clock). */
const paceFor = (host: string, turn: number): number => {
  let h = turn >>> 0;
  for (let i = 0; i < host.length; i++) h = Math.imul(h ^ host.charCodeAt(i), 16777619) >>> 0;
  return BROWSER_PACE_MS.min + (h % (BROWSER_PACE_MS.max - BROWSER_PACE_MS.min + 1));
};

/** Run `job` as this host's next turn: one at a time, at least 3 to 5 seconds after the host's previous navigation. */
async function onHostTurn<T>(deps: BrowserDeps, s: Session, host: string, job: () => Promise<T>): Promise<T> {
  const now = () => (deps.now ? deps.now().getTime() : Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const run = (s.turns.get(host) ?? Promise.resolve()).then(async () => {
    const last = s.lastAt.get(host);
    const gap = paceFor(host, s.lastAt.size + (last ?? 0));
    if (last !== undefined && now() - last < gap) await sleep(gap - (now() - last));
    try {
      return await job();
    } finally {
      s.lastAt.set(host, now());
    }
  });
  s.turns.set(host, run.catch(() => undefined));
  return run;
}

/** The robots verdict for a URL, as the gate has it; for a host that refused the declared identity robots.txt itself, the file is read once as a person's browser would and the rules for our token are applied. */
async function verdictForBrowser(deps: BrowserDeps, s: Session, url: URL, context: BrowserContextLike): Promise<RobotsVerdict> {
  const v = await robotsGateFor(deps)(url.toString());
  if (v.status !== "unknown" || !v.identityRefused) return v;
  return onHostTurn(deps, s, url.host, async () => {
    const page = await context.newPage();
    try {
      const res = await page.goto(`${url.origin}/robots.txt`, { waitUntil: "networkidle", timeout: 30_000 });
      const answer = interpretRobotsAnswer({ status: res?.status() ?? null, text: decodeEntities(stripTags(await page.content())), contentType: "text/plain" });
      return answer.verdict && answer.verdict.status === "unknown" ? v : verdictFor(answer.file, `${url.pathname}${url.search}`);
    } finally {
      await page.close();
    }
  });
}

/**
 * Read `url` in the run's browser and return its visible text. Refuses without navigating when robots.txt disallows it or is unknown, or the source is paywalled; refuses after loading when the page is a CAPTCHA or
 * another interactive challenge, or a login or paywall gate. The page is read when the network is idle and its content has stopped changing, not at first parse. The hold gate runs first.
 */
export async function fetchBrowser(url: string, deps: BrowserDeps, opts: BrowserCtx & { max: number }): Promise<TransportResult> {
  await assertFetchAllowed(url, deps.caller, deps);
  const max = opts.max;
  if (opts.paywalled) return refused(max, "paywalled", false, "the source is paywalled: the browser tier does not run on it");
  if (!deps.launchBrowser && deps.env?.GITHUB_ACTIONS !== "true") return result(max, 0, { needsHeadless: true });
  const target = new URL(url);
  const s = sessionOf(deps);
  let context = s.contexts.get(target.host);
  try {
    if (!context) {
      context = await (await browserOf(deps, s)).newContext();
      s.contexts.set(target.host, context);
    }
  } catch (e) {
    return isAbsent(e) ? result(max, 0, { needsHeadless: true }) : refused(max, "browser_launch_failed", true, `the browser could not be started: ${e instanceof Error ? e.message : String(e)}`);
  }
  const verdict = await verdictForBrowser(deps, s, target, context);
  if (verdict.status === "disallowed") return refused(max, "robots_disallowed", false, `robots.txt of ${target.host} disallows ${target.pathname}${verdict.rule ? ` (${verdict.rule})` : ""}: the browser tier honours it`, verdict.rule ?? undefined);
  if (verdict.status === "unknown") return refused(max, "robots_unknown", true, `robots.txt of ${target.host} could not be read (${verdict.reason ?? "unknown"}): deferred, not denied`);
  return onHostTurn(deps, s, target.host, async () => {
    const page = await (context as BrowserContextLike).newPage();
    try {
      const res = await page.goto(url, { waitUntil: "networkidle", timeout: opts.timeoutMs ?? 45_000 });
      let html = await page.content();
      for (let settle = 0; settle < 3; settle++) {
        await page.waitForTimeout(500);
        const again = await page.content();
        if (again.length === html.length) break;
        html = again;
      }
      const status = res?.status() ?? 200;
      const text = toText(html);
      const gate = detectAccessWall(text);
      if (text.length < WALL_MAX_CHARS && (gate?.class === BODY_CLASS.INTERACTIVE_CHALLENGE || INTERACTIVE_CHALLENGE_RE.test(html))) return refused(max, "interactive_challenge", false, `the page presents an interactive challenge (${(gate?.evidence ?? "challenge markup").slice(0, 120)}): recorded, never solved`);
      if (gate?.class === BODY_CLASS.LOGIN_WALL || gate?.class === BODY_CLASS.REQUEST_ACCESS) return refused(max, "gated", false, `the page is a login or access gate (${gate.class}): the browser tier does not enter one`);
      return { status, text: text.slice(0, max), truncated: text.length > max, fullLength: text.length, cap: max, finalUrl: page.url(), contentType: "text/html", html, language: documentLanguage(null, html), channel: "browser" } satisfies TransportResult;
    } catch (e) {
      return refused(max, "network", true, `browser navigation failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await page.close();
    }
  });
}
