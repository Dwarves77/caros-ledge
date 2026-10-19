// Ported from old_repo/scripts/mint/export-census-rows.mjs (lines 590-649)
// Ported from old_repo/scripts/mint/export-census-rows.mjs (lines 1040-1195)
// Ported from old_repo/scripts/lib/eurlex-cellar.mjs (lines 1-33)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 1057-1099)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 1114-1199)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 1240-1330)
import { toText } from "./classify-body";
import { classifyBody, isStorableClass } from "./classify-body";
import { celexTxtHtmlUrl } from "./candidates";
import { FEDERAL_REGISTER_API_BASE } from "./api";
import { type FetchDeps, fetchDirect } from "./direct";
import type { GuardRefusal } from "./guard";
import { assertFetchAllowed } from "./hold";
import { honestFetch } from "./honest";
import { DECLARED_HEADERS, decodeBody, MAX_TEXT_BYTES, readBodyCapped } from "./policy";
import { detectCellarGarbledMetadata, extractCellarTitle, extractEurlexTitle, extractTitleFromHtml } from "./titles";

export type CaptureFamily = "celex" | "uk_legislation" | "federal_register" | "oj_issue" | "generic";
export interface CaptureAttempt {
  endpoint: string;
  transport: string;
  status: number | null;
  bytes: number;
  head: string;
}
export interface CaptureResult {
  usable: boolean;
  text: string | null;
  title: string | null;
  titleOrigin: string | null;
  /** The transport that produced the text: cellar, eurlex_txt, uk_data_htm, uk_page, fr_api, oj_cellar or direct. */
  transport: string;
  /** Which channel produced it (R2c C7): `api` for a publisher's resource or API endpoint, `direct` for a page GET. The ladder adds feed, browser and substitute. */
  channel: "api" | "direct" | null;
  /** Why nothing was captured: capture_blocked, capture_thin, no_capture_path or oj_reference_no_cellar_path; null when usable. */
  holdReason: string | null;
  status: number | null;
  endpoint: string | null;
  /** The raw markup, in memory only (a one-hop link follow reads it); never stored. */
  html: string | null;
  attempts: CaptureAttempt[];
  /** The typed guard refusal behind a hold, when one was the cause (robots.txt disallowed, a private address): the source's collection state is recorded from it. */
  refusal?: { reason: string; rule?: string; detail: string } | null;
}
export interface CaptureDeps extends FetchDeps {
  /** Per-host politeness (one request per second at most), shared across a run. */
  throttle: ((host: string) => Promise<void>) | null;
}
const CELLAR_CELEX_PREFIX = "https://publications.europa.eu/resource/celex/";

/** Cellar's CELEX resolver URL for a key; the parentheses are percent-encoded explicitly (the resolver 404s a literal-paren OJ-suffixed key). */
const cellarEndpointForCelex = (key: string): string => `${CELLAR_CELEX_PREFIX}${encodeURIComponent(String(key)).replace(/\(/g, "%28").replace(/\)/g, "%29")}`;
/** The Publications Office's OJ-issue resource URL for one series, year, issue and edition letter. */
const cellarEndpointForOj = ({ series, year, issue }: { series: string; year: string; issue: string }, edition: string): string => `https://publications.europa.eu/resource/oj/${series === "L" ? "JOL" : "JOC"}_${year}_${issue}_${edition}`;
/** EUR-Lex's JS bot gate: HTTP 202 with the "verify that you're not a robot" interstitial. Detected by status and marker text, never by byte count. */
const isEurlexRobotGate = (status: number | null, head: string): boolean => Number(status) === 202 && /verify that you.?re not a robot/i.test(String(head ?? ""));

/** An eur-lex `uri=OJ:...` value as { series, year, issue (5-digit), edition }; the three OJ-issue shapes (JOL_2025_040_R, L_2025_040, L_202500040). Null for a CELEX or ELI reference. */
export function parseOjReference(url: string): { series: string; year: string; issue: string; edition: string | null } | null {
  let uri: string | null = null;
  try {
    uri = new URL(String(url)).searchParams.get("uri");
  } catch {
    uri = String(url).match(/[?&]uri=([^&]+)/)?.[1] ?? null;
  }
  if (!uri) return null;
  let m = /^OJ:(JO[LC])_(\d{4})_(\d{1,5})(?:_([A-Za-z]))?$/i.exec(uri);
  if (m) return { series: (m[1] ?? "").toUpperCase() === "JOL" ? "L" : "C", year: m[2] ?? "", issue: (m[3] ?? "").padStart(5, "0"), edition: m[4] ? m[4].toUpperCase() : null };
  m = /^OJ:([LC])_(\d{4})_(\d{1,5})$/i.exec(uri) ?? /^OJ:([LC])_(\d{4})(\d{1,5})$/i.exec(uri);
  return m ? { series: (m[1] ?? "").toUpperCase(), year: m[2] ?? "", issue: (m[3] ?? "").padStart(5, "0"), edition: null } : null;
}

/** A GET under the declared identity (the guard follows redirects by hand, upgrading any http Location to https: Cellar's 303 points at plain http), with the politeness gap and the hold gate before the first hop. */
async function get(url: string, deps: CaptureDeps): Promise<{ ok: boolean; status: number | null; html: string; error: string | null; refusal: GuardRefusal | null }> {
  await assertFetchAllowed(url, deps.caller, deps);
  if (deps.throttle) await deps.throttle(new URL(url).hostname);
  try {
    const res = await honestFetch(deps)(url, { headers: DECLARED_HEADERS, signal: AbortSignal.timeout(20_000) });
    const html = decodeBody(await readBodyCapped(res, MAX_TEXT_BYTES), res.headers.get("content-type")).text;
    return { ok: res.ok, status: res.status, html, error: res.ok ? null : `HTTP ${res.status}`, refusal: null };
  } catch (e) {
    return { ok: false, status: null, html: "", error: (e as Error).message, refusal: (e as { fetchRefusal?: GuardRefusal }).fetchRefusal ?? null };
  }
}

type Titler = (html: unknown) => { title: string; origin: string } | null;
interface Env {
  usable: boolean;
  status: number | null;
  html: string;
  text: string;
  endpoint: string;
  title?: { title: string; origin: string } | null;
  refusal?: GuardRefusal | null;
}
/** One fetched document as an envelope. Usable means ok, over 200 characters of text, not Cellar's metadata fingerprint and not a wall or error body. */
function envelope(res: { ok: boolean; status: number | null; html: string; refusal?: GuardRefusal | null }, endpoint: string, titler?: Titler): Env {
  const text = toText(res.html);
  const usable = res.ok && text.length > 200 && !detectCellarGarbledMetadata(text) && isStorableClass(classifyBody(text).class);
  return { usable, status: res.status, html: res.html, text: usable ? text : "", endpoint, refusal: res.refusal ?? null, ...(usable && titler ? { title: titler(res.html) } : {}) };
}
const attemptOf = (env: Env, transport: string, rawText?: string): CaptureAttempt => ({ endpoint: env.endpoint, transport, status: env.status, bytes: env.html.length, head: (rawText ?? toText(env.html)).slice(0, 300) });

/**
 * The one polite free capture: per-family transports in order, each behind the hold gate. celex: Cellar first, EUR-Lex clean text second (their robot gate is `no_capture_path`); uk_legislation: data.htm then the page;
 * federal_register: the API's raw text; oj_issue: Cellar's OJ resource (both editions when inferred); generic: a direct GET (HTML or PDF). Every GET is under the declared identity and robots.txt. A refusal is a hold with
 * its reason (and the typed guard refusal behind it): no archive, no cache and no proxy is ever read to pass a wall. No metered render anywhere. Never throws past a hold refusal; every attempt is on the result.
 */
export async function capture(url: string, opts: { family?: CaptureFamily; key?: string | null }, deps: CaptureDeps): Promise<CaptureResult> {
  const attempts: CaptureAttempt[] = [];
  const channelOf = (transport: string): "api" | "direct" => (/^(cellar|fr_api|oj_cellar|uk_data_htm)$/.test(transport) ? "api" : "direct");
  const done = (env: Env, transport: string): CaptureResult => ({ usable: true, channel: channelOf(transport), text: env.text, title: env.title?.title ?? null, titleOrigin: env.title?.origin ?? null, transport, holdReason: null, status: env.status, endpoint: env.endpoint, html: env.html || null, attempts });
  const held = (reason: string, last: { status: number | null; endpoint: string | null; refusal?: GuardRefusal | null } = { status: null, endpoint: null }): CaptureResult => ({ usable: false, text: null, title: null, titleOrigin: null, transport: "none", channel: null, holdReason: reason, status: last.status, endpoint: last.endpoint, html: null, attempts, refusal: (last as { refusal?: GuardRefusal | null }).refusal ?? null });
  const tryDoc = async (endpoint: string, transport: string, titler?: Titler): Promise<Env> => {
    const env = envelope(await get(endpoint, deps), endpoint, titler);
    attempts.push(attemptOf(env, transport));
    return env;
  };
  const family = opts.family ?? "generic";
  const unusableReason = (e: Env) => (e.status != null && e.status >= 200 && e.status < 300 ? "capture_thin" : "capture_blocked");
  let last: Env | null = null;

  if (family === "celex" && opts.key) {
    const cellar = await tryDoc(cellarEndpointForCelex(opts.key), "cellar", extractCellarTitle);
    if (cellar.usable) return done(cellar, "cellar");
    const eur = await tryDoc(celexTxtHtmlUrl(opts.key), "eurlex_txt", extractEurlexTitle);
    if (eur.usable) return done(eur, "eurlex_txt");
    last = eur;
    if (isEurlexRobotGate(eur.status, attempts[attempts.length - 1]?.head ?? "")) return held("no_capture_path", eur);
  } else if (family === "uk_legislation") {
    const data = await tryDoc(`${url.replace(/\/+$/, "")}/data.htm`, "uk_data_htm", extractTitleFromHtml);
    if (data.usable) return done(data, "uk_data_htm");
    const page = await tryDoc(url, "uk_page", extractTitleFromHtml);
    if (page.usable) return done(page, "uk_page");
    last = page;
  } else if (family === "federal_register" && opts.key) {
    const endpoint = `${FEDERAL_REGISTER_API_BASE}/documents/${opts.key}.json`;
    const meta = await get(endpoint, deps);
    let json: { title?: string; raw_text_url?: string } | null = null;
    try {
      json = meta.ok ? (JSON.parse(meta.html) as { title?: string; raw_text_url?: string }) : null;
    } catch {
      json = null;
    }
    attempts.push({ endpoint, transport: "fr_api", status: meta.status, bytes: meta.html.length, head: meta.html.slice(0, 300) });
    if (!json?.raw_text_url) return held("capture_blocked", { status: meta.status, endpoint });
    const doc = await tryDoc(json.raw_text_url, "fr_api");
    if (doc.usable) return done({ ...doc, title: json.title ? { title: json.title, origin: "fr_api_title" } : null }, "fr_api");
    last = doc;
  } else if (family === "oj_issue") {
    const ref = parseOjReference(url);
    if (!ref) return held("canonical_key_unresolved");
    for (const edition of ref.edition ? [ref.edition] : ref.series === "L" ? ["R", "C"] : ["C", "R"]) {
      const env = await tryDoc(cellarEndpointForOj(ref, edition), "oj_cellar");
      if (env.usable) return done(env, "oj_cellar");
    }
    return held("oj_reference_no_cellar_path");
  } else {
    const res = await fetchDirect(url, deps, { max: 10_000_000, keepHtml: true });
    const env: Env = { usable: res.status === 200 && isStorableClass(classifyBody(res.text, { status: res.status }).class) && res.text.length > 200, status: res.status || null, html: res.html ?? "", text: res.text, endpoint: res.finalUrl ?? url, title: res.title ? { title: res.title, origin: "captured_title" } : null };
    attempts.push(attemptOf(env, "direct", res.text));
    if (env.usable) return done(env, "direct");
    last = { ...env, refusal: res.refusal && /^(robots_|private_address|host_busy)/.test(res.refusal.reason) ? { reason: res.refusal.reason as GuardRefusal["reason"], transient: res.refusal.transient, detail: res.refusal.detail, ...(res.refusal.rule ? { rule: res.refusal.rule } : {}) } : null };
  }

  const why = last?.refusal?.reason;
  return held(why === "robots_disallowed" ? "robots_disallowed" : why === "robots_unknown" || why === "host_busy" ? "robots_deferred" : why === "private_address" ? "private_address" : last ? unusableReason(last) : "capture_blocked", last ?? { status: null, endpoint: null });
}

/** A rate-limited gate bound to one politeness gap (default 1,000 ms), shared across every fetch of a run. The clock and the sleep are injected. */
export function makePoliteGate({ gapMs = 1000, now, sleep }: { gapMs?: number; now: () => number; sleep: (ms: number) => Promise<void> }): (host: string) => Promise<void> {
  const lastAt = new Map<string, number>();
  return async (host) => {
    const wait = (lastAt.get(host) ?? -Infinity) + gapMs - now();
    if (wait > 0) await sleep(wait);
    lastAt.set(host, now());
  };
}
