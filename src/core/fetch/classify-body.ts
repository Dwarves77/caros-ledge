// Ported from old_repo/src/lib/sources/entity-gate.mjs (lines 1-92)
// Ported from old_repo/src/lib/sources/primary-fallback.mjs (lines 1-80)
// Ported from old_repo/src/lib/sources/transport-escalation.mjs (lines 6-84)
// Ported from old_repo/src/lib/sources/access-wall.mjs (lines 1-136)
// Ported from old_repo/src/lib/sources/holdings-audit.mjs (lines 135-155)
// Ported from old_repo/scripts/mint/export-census-rows.mjs (lines 299-321)
import { decodeEntities, stripTags } from "./entities";

/** The one body-class vocabulary. Status classes (not_found, http_403, http_5xx, timeout) come from the transport; the rest from the body. */
export const BODY_CLASS = {
  OK: "ok",
  NOT_FOUND: "not_found",
  SOFT_404: "soft_404",
  HTTP_403: "http_403",
  HTTP_5XX: "http_5xx",
  TIMEOUT: "timeout",
  BOT_WALL: "bot_wall",
  CDN_BLOCK: "cdn_block",
  REQUEST_ACCESS: "request_access",
  JS_SHELL: "js_shell",
  COOKIE_WALL: "cookie_wall",
  LOGIN_WALL: "login_wall",
  INTERFACE_SHELL: "interface_shell",
  FURNITURE: "furniture",
  ERROR_BODY: "error_body",
  EMPTY: "empty",
  WRONG_LANGUAGE: "wrong_language",
  /** A CAPTCHA or other challenge that wants a person to act: the browser tier never solves, clicks through or waits out one (R2c addendum B). */
  INTERACTIVE_CHALLENGE: "interactive_challenge",
} as const;
export type BodyClass = (typeof BODY_CLASS)[keyof typeof BODY_CLASS];

/** A capture may be stored when it is real content, in any language (a non-English instrument is still the source; only the English-only fallback hunts past it). */
export const isStorableClass = (c: BodyClass): boolean => c === BODY_CLASS.OK || c === BODY_CLASS.WRONG_LANGUAGE;

// Structure marks (Unicode noncharacters, never in a document): a block edge, a line break, a cell end, a row end, a table end. In a run of adjacent marks the strongest wins: table, row, cell, block, break.
const [M_BLOCK, M_BR, M_CELL, M_ROW, M_TABLE] = ["\ufdd0", "\ufdd1", "\ufdd2", "\ufdd3", "\ufdd4"] as const;
const MARKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/<\/table\b/gi, M_TABLE], [/<\/tr\b/gi, M_ROW], [/<\/t[dh]\b/gi, M_CELL],
  [/<\/?(?:p|div|h[1-6]|li|ul|ol|section|article|blockquote|pre|table|figure|caption|dl|dt|dd|header|footer)\b/gi, M_BLOCK], [/<br\b/gi, M_BR],
];
const layoutOf = (run: string): string =>
  run.includes(M_TABLE) ? "\n\n" : run.includes(M_ROW) ? "\n" : run.includes(M_CELL) ? "\t".repeat(run.split(M_CELL).length - 1) : run.includes(M_BLOCK) ? "\n\n" : run.includes(M_BR) ? "\n" : " ";

/** Layout whitespace kept, every other run of whitespace one space: spaces around a line break or a tab dropped, no run of three line breaks, trimmed. Collapsing its result to single spaces gives the input collapsed, as before. */
export const tidyLayout = (s: string): string => s.replace(/[^\S\n\t]+/g, " ").replace(/ ?([\n\t]) ?/g, "$1").replace(/\n{3,}/g, "\n\n").trim();

/**
 * The ONE text stripper for capture, grounding, verification and the walkers: scripts and styles dropped, comments and tags removed by one linear pass, character references decoded once (entities.ts), U+0000 removed
 * (Postgres cannot store it). The page's structure survives as whitespace: a block edge is a blank line, a <br> and a table row end are a line break, a table cell end is a tab, every other run of whitespace is one space.
 * Invariant I1: collapsing all whitespace to one space gives exactly what this function gave before it kept structure, so the change fingerprint and the storage hash (store-capture.ts) are unchanged.
 */
export const toText = (html: unknown): string => {
  let h = String(html ?? "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  for (const [re, mark] of MARKS) h = h.replace(re, (tag) => mark + tag);
  return decodeEntities(stripTags(h)).replace(/\u0000/g, "").replace(/\s+/g, " ").replace(/[ \ufdd0-\ufdd4]+/g, layoutOf).trim();
};

/** Real content floor: below this extracted text is a stub or roadblock. */
export const MIN_CONTENT_CHARS = 200;
/** A wall page is short next to a real article; a long article that merely mentions cookies or sign-in is exempt. */
export const WALL_MAX_CHARS = 1500;
const MIN_LANG_RATIO = 0.6;

const REQUEST_ACCESS_RE = /request access|you (?:do not|don'?t) have permission to access|access to this page (?:has been|is) denied|permission to access .* on this server|to continue,? (?:please )?(?:enable|verify|confirm)/i;
const JS_SHELL_RE = /javascript is required|javascript required|requires javascript|(?:please )?enable javascript|you need to enable javascript|this (?:page|site|app) requires javascript|<noscript/i;
/** A challenge that needs a person (a CAPTCHA, a "press and hold", an "are you human" box). Checked before the generic wall words so it is named for what it is. */
export const INTERACTIVE_CHALLENGE_RE = /captcha|turnstile|verify (?:that )?you(?:(?:'|’)?re| are) (?:a )?human|are you (?:a )?(?:human|robot)|press (?:and|&) hold|i(?:'|’)m not a robot/i;
const CHALLENGE_RE = /just a moment|performing security verification|enable javascript|access denied|attention required|cloudflare|captcha|ddos protection/i;
const SOFT_404_RE = /\b(page not found|404 not found|404 error|error 404|document not found|no documents (?:found|matching)|page (?:does not|doesn'?t) exist|page (?:is )?(?:no longer available|unavailable)|requested (?:page|document|url)(?: was| could)? not (?:be )?found)\b/i;
const CDN_BLOCK_RE = /the request could not be satisfied|request blocked\b|generated by cloudfront|akamai reference|reference\s*#\s*[0-9a-f]{6}|varnish cache server|error 5\d\d \(|^error 4\d\d\b/i;
const COOKIE_CONSENT_RE = /(?:this (?:site|website) uses cookies|we use cookies to|by (?:using|continuing to (?:use|browse)) this (?:site|website)|cookie (?:consent|settings|preferences|policy))[\s\S]{0,400}(?:accept(?: all)?(?: cookies)?|allow all|manage (?:cookie )?preferences|i agree|got it)/i;
const LOGIN_WALL_RE = /(?:please )?(?:sign in|log ?in) to (?:continue|view|access|read)|you must (?:be logged in|sign in) to|this content is (?:only )?available to (?:subscribers|members|registered users)|subscription required|create a (?:free )?account to continue|members?-only content|register (?:for free )?to (?:continue|view|read)/i;
const BROWSER_NOT_SUPPORTED_RE = /your browser is (?:no longer|not) (?:fully )?supported|please (?:upgrade|update) your browser|this (?:site|browser|page) requires? an? (?:modern|newer|updated) browser|browser (?:is )?out of date/i;
const EURLEX_CHROME_RE = /my eur-lex|eur-lex\s+access to european union law|select your language|browse by eu institutions|official eu languages/i;
const LEGISLATIVE_BODY_RE = /\barticle\s+1\b(?!\d)|has adopted this (?:regulation|directive|decision)|has decided as follows|^\s*whereas:|the european (?:parliament|commission|council)(?: and of the council)? (?:has|have) adopted/im;

const ERROR_SIGNATURES: readonly RegExp[] = [
  /the request could not be satisfied/i, /generated by cloudfront/i, /request blocked/i, /\b403\b\s*(error|forbidden)?/i, /\bforbidden\b/i, /access denied/i, /attention required/i, /just a moment\b/i,
  /\bare you (a )?(human|robot)\b/i, /\bcaptcha\b/i, /please (enable|turn on) (javascript|cookies)/i, /(temporarily )?(unavailable|inaccessible)\b/i, /service unavailable/i, /too many requests/i, /\b429\b/,
  /\b50[0234]\b\s*(error|bad gateway|gateway timeout|unavailable)?/i, /\b404\b|\bpage not found\b|\bnot found\b/i, /content unavailable/i,
];
/** Distinct error-signature markers in the first 2,500 characters. */
function errorMarkerCount(text: string | null | undefined): number {
  if (!text) return 0;
  const head = text.slice(0, 2500);
  return ERROR_SIGNATURES.filter((re) => re.test(head)).length;
}
/**
 * An error or bot-block body, judged by structure (R2c C7, register row C:3): empty or tiny, or SHORT with a signature in it. A body at or over the wall floor is a document, never an error page, however many of
 * the loose words ("unavailable", "forbidden", "not found") its prose carries.
 */
export function isErrorBody(text: string | null | undefined): boolean {
  const len = text?.trim().length ?? 0;
  if (len < 60) return true;
  return len < WALL_MAX_CHARS && errorMarkerCount(text) >= 1;
}

const FURNITURE_MARKERS = /skip to (?:main )?content|accept (?:all )?cookies?|cookie (?:policy|settings|preferences)|sign in|log ?in|newsletter|subscribe|main menu|primary navigation|site footer|breadcrumb|back to top|share this|follow us|change your cookie/gi;
/** Conservative furniture gate: short extracted text, under 2 real sentences and 2 or more chrome markers. Real thin legal text is never rejected. */
function looksLikeFurniture(text: string | null | undefined): boolean {
  const t = String(text || "");
  if (t.length > 3000) return false;
  const sentences = t.split(/(?<=[.;:])\s+|\n+/).filter((s) => s.trim().length > 40);
  return sentences.length < 2 && (t.match(FURNITURE_MARKERS) || []).length >= 2;
}

/** Cheap target-language proxy: the fraction of ASCII characters. */
export function targetLangRatio(text: string | null | undefined): number {
  const s = String(text || "");
  return s.length ? (s.match(/[\x00-\x7F]/g) || []).length / s.length : 0;
}

/** EUR-Lex /legal-content/ page whose captured window is all portal chrome and no instrument body; a genuine EUR-Lex portal page is not flagged. */
function looksLikeEurlexInterfaceShell(text: string, opts: { host?: string | null; path?: string | null } = {}): boolean {
  const host = (opts.host || "").toLowerCase().replace(/^www\./, "");
  if (host && !/(^|\.)eur-lex\.europa\.eu$/.test(host)) return false;
  if (opts.path && !/\/legal-content\//i.test(opts.path)) return false;
  return EURLEX_CHROME_RE.test(text) && !LEGISLATIVE_BODY_RE.test(text);
}

/** The portal-homepage test: a root URL or a single shallow landing segment (/en, /home, /index.html). */
export function urlIsRoot(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length === 0) return true;
  return segs.length === 1 && !u.search && /^(en|en-us|en-gb|fr|de|es|pt|it|home|index(\.[a-z0-9]+)?|default(\.[a-z0-9]+)?|main|portal|start|welcome)$/i.test(segs[0] ?? "");
}

export interface BodyVerdict {
  class: BodyClass;
  /** The matched head snippet, for the exhaustion record. */
  evidence: string;
}
const verdict = (cls: BodyClass, evidence = ""): BodyVerdict => ({ class: cls, evidence: evidence.slice(0, 200) });

export type BodyOpts = { status?: number; timedOut?: boolean; host?: string | null; path?: string | null };
/** The options of a fetched URL: its host and path beside the status, so a rule that belongs to one host (the EUR-Lex interface shell) stays on that host. A caller that knows the URL passes it here; a body with no host is judged by the host-free rules and the EUR-Lex one. */
export function bodyOpts(url: string | null | undefined, extra: Pick<BodyOpts, "status" | "timedOut"> = {}): BodyOpts {
  try {
    const u = new URL(String(url));
    return { ...extra, host: u.hostname, path: u.pathname };
  } catch {
    return extra;
  }
}
/** The wall subset, one head window per signal. With `stubFloor`, a body under the real-content floor is a stub (a challenge page or a JS shell). */
function wallVerdict(s: string, opts: BodyOpts, stubFloor: boolean): BodyVerdict | null {
  const len = s.trim().length;
  const head300 = s.slice(0, 300);
  const head600 = s.slice(0, 600);
  const head800 = s.slice(0, 800);
  const short = len < WALL_MAX_CHARS;
  if (short && INTERACTIVE_CHALLENGE_RE.test(head600)) return verdict(BODY_CLASS.INTERACTIVE_CHALLENGE, head600);
  if (short && REQUEST_ACCESS_RE.test(head600)) return verdict(BODY_CLASS.REQUEST_ACCESS, head600);
  if (short && JS_SHELL_RE.test(head600)) return verdict(BODY_CLASS.JS_SHELL, head600);
  if (stubFloor && len < MIN_CONTENT_CHARS) return verdict(CHALLENGE_RE.test(s) ? BODY_CLASS.BOT_WALL : BODY_CLASS.JS_SHELL, s);
  if (short && CHALLENGE_RE.test(head600)) return verdict(BODY_CLASS.BOT_WALL, head600);
  if (short && SOFT_404_RE.test(head300)) return verdict(BODY_CLASS.SOFT_404, head300);
  if (short && CDN_BLOCK_RE.test(head300)) return verdict(BODY_CLASS.CDN_BLOCK, head300);
  if (len < WALL_MAX_CHARS && COOKIE_CONSENT_RE.test(head800)) return verdict(BODY_CLASS.COOKIE_WALL, head800);
  if (len < WALL_MAX_CHARS && LOGIN_WALL_RE.test(head800)) return verdict(BODY_CLASS.LOGIN_WALL, head800);
  if (BROWSER_NOT_SUPPORTED_RE.test(head800) || looksLikeEurlexInterfaceShell(s, opts)) return verdict(BODY_CLASS.INTERFACE_SHELL, head300);
  return null;
}
/** The content-based access-wall detector (a 200 that is a CAPTCHA, challenge, consent, login or interface shell); null when the text looks like real content. No stub floor: a short non-wall body is not a wall. */
export function detectAccessWall(text: string | null | undefined, opts: BodyOpts = {}): BodyVerdict | null {
  const s = String(text || "");
  return s.trim().length === 0 ? null : wallVerdict(s, opts, false);
}

/**
 * THE body classifier (INV-178): one result enum, one head window per signal. A status, a timeout or a body in; the class out.
 * `ok` (or a non-English `wrong_language`) is the only class a capture may be stored as.
 */
export function classifyBody(text: string | null | undefined, opts: BodyOpts = {}): BodyVerdict {
  const { status = 200, timedOut = false } = opts;
  if (timedOut) return verdict(BODY_CLASS.TIMEOUT);
  if (status === 404 || status === 410) return verdict(BODY_CLASS.NOT_FOUND, `http ${status}`);
  if (status >= 500) return verdict(BODY_CLASS.HTTP_5XX, `http ${status}`);
  if (status >= 400) return verdict(BODY_CLASS.HTTP_403, `http ${status}`);
  const s = String(text || "");
  if (s.trim().length === 0) return verdict(BODY_CLASS.EMPTY);
  const wall = wallVerdict(s, opts, true);
  if (wall) return wall;
  if (isErrorBody(s)) return verdict(BODY_CLASS.ERROR_BODY, s.slice(0, 300));
  if (looksLikeFurniture(s)) return verdict(BODY_CLASS.FURNITURE, s.slice(0, 300));
  if (targetLangRatio(s) < MIN_LANG_RATIO) return verdict(BODY_CLASS.WRONG_LANGUAGE);
  return verdict(BODY_CLASS.OK);
}
