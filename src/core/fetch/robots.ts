// New in R2c: no old counterpart (the old tree evaluated robots.txt nowhere, register row D:49).
// RFC 9309 robots.txt. Import-free, so the Edge Function (Deno) and the Node transports share it by relative path. Pure parsing and evaluation, then one reader that turns a robots.txt answer into a verdict.

/** The product token a robots.txt group may name for this crawler (the rest of the identity is BOT_USER_AGENT in policy.ts). */
export const ROBOTS_PRODUCT_TOKEN = "CarosLedge";
/** RFC 9309 section 2.5: a crawler parses at least 500 KiB; the rest is ignored. */
export const ROBOTS_MAX_BYTES = 500 * 1024;
/** Our own floor between two requests to one host. A Crawl-delay for our group raises it, never lowers it. */
export const MIN_HOST_GAP_MS = 1000;

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}
export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySec: number | null;
}
export interface RobotsFile {
  groups: RobotsGroup[];
  sitemaps: string[];
  /** A contact the publisher wrote into the file (a `Contact:` line or an e-mail address in a comment); null when none. */
  contact: string | null;
}
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
/** The contact a robots.txt publishes, from a `Contact:` line or any e-mail address in it (comments included); an address on a reserved example domain does not count. */
export function findContact(body: string): string | null {
  const line = /^\s*#?\s*contact\s*:\s*(\S.*?)\s*$/im.exec(body)?.[1];
  const hit = line ?? EMAIL.exec(body)?.[0] ?? null;
  return hit && !/@(?:example\.(?:com|org|net)|localhost)\b/i.test(hit) ? hit.slice(0, 200) : null;
}

/** Parse a robots.txt body: groups are runs of User-agent lines followed by rules; a User-agent line after a rule starts a new group. Unknown fields and comments are ignored; a malformed line is skipped. */
export function parseRobots(body: string): RobotsFile {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let collectingAgents = false;
  for (const raw of body.slice(0, ROBOTS_MAX_BYTES).replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
    } else if (field === "user-agent") {
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [], crawlDelaySec: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
    } else if (current && (field === "allow" || field === "disallow")) {
      collectingAgents = false;
      if (value) current.rules.push({ allow: field === "allow", pattern: value });
    } else if (current && field === "crawl-delay") {
      collectingAgents = false;
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = n;
    }
  }
  return { groups, sitemaps, contact: findContact(body.slice(0, ROBOTS_MAX_BYTES)) };
}

/** The groups that apply to a product token: the groups naming it, else the `*` groups; several groups for one agent are one combined group (RFC 9309 section 2.2.1). */
export function groupFor(file: RobotsFile, token = ROBOTS_PRODUCT_TOKEN): RobotsGroup | null {
  const t = token.toLowerCase();
  const named = file.groups.filter((g) => g.agents.includes(t));
  const chosen = named.length ? named : file.groups.filter((g) => g.agents.includes("*"));
  if (!chosen.length) return null;
  const delays = chosen.map((g) => g.crawlDelaySec).filter((d): d is number => d !== null);
  return { agents: [named.length ? t : "*"], rules: chosen.flatMap((g) => g.rules), crawlDelaySec: delays.length ? Math.max(...delays) : null };
}

const normalizePercent = (s: string): string => s.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
/** Does a robots path pattern (with `*` and a trailing `$`) match the start of `target`? */
export function patternMatches(pattern: string, target: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = normalizePercent(anchored ? pattern.slice(0, -1) : pattern);
  const re = new RegExp(`^${body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${anchored ? "$" : ""}`);
  return re.test(normalizePercent(target));
}

export interface PathDecision {
  allowed: boolean;
  /** The matching rule, as written ("Disallow: /x"), null when no rule matched. */
  rule: string | null;
}
/** Longest matching pattern wins; Allow wins a tie (RFC 9309 section 2.2.2). No matching rule means allowed. */
export function decidePath(group: RobotsGroup | null, pathAndQuery: string): PathDecision {
  let best: RobotsRule | null = null;
  for (const r of group?.rules ?? []) {
    if (!patternMatches(r.pattern, pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
  }
  return best ? { allowed: best.allow, rule: `${best.allow ? "Allow" : "Disallow"}: ${best.pattern}` } : { allowed: true, rule: null };
}

/** What the fetcher knows about a URL's robots.txt. `no_robots` and `allowed` let the fetch proceed; `disallowed` records the rule; `unknown` defers (never denies, never allows). */
export interface RobotsVerdict {
  status: "allowed" | "no_robots" | "disallowed" | "unknown";
  rule: string | null;
  /** Seconds the host asked us to wait between requests; null when it said nothing. */
  crawlDelaySec: number | null;
  /** Why the verdict is `unknown` (the status or the network error); null otherwise. */
  reason: string | null;
  sitemaps: string[];
  /** The contact the host published in robots.txt, null when none. */
  contact: string | null;
  /** True when the host answered the robots.txt request itself with 401, 403 or 429 (the identity was refused): the browser tier may re-read it as a person's browser would. */
  identityRefused: boolean;
}
export interface RobotsAnswer {
  status: number | null;
  /** The decoded body; empty when none. */
  text: string;
  /** The network error message when there was no response. */
  error?: string | null;
  contentType?: string | null;
}

/** A robots.txt answer to the parsed file or a verdict that says why there is none. 404 and the other 4xx but 401, 403 and 429 mean no rules; 401, 403, 429, 5xx and a network error mean unknown. */
export function interpretRobotsAnswer(a: RobotsAnswer): { file: RobotsFile | null; verdict: RobotsVerdict | null } {
  const base = { rule: null, crawlDelaySec: null, sitemaps: [] as string[], contact: null, identityRefused: false };
  if (a.status === null) return { file: null, verdict: { ...base, status: "unknown", reason: a.error ?? "no response" } };
  if (a.status === 401 || a.status === 403 || a.status === 429) return { file: null, verdict: { ...base, status: "unknown", reason: `robots.txt answered ${a.status}`, identityRefused: true } };
  if (a.status >= 500) return { file: null, verdict: { ...base, status: "unknown", reason: `robots.txt answered ${a.status}` } };
  if (a.status >= 400 || a.status < 200 || a.status >= 300) return { file: null, verdict: { ...base, status: "no_robots", reason: null } };
  const html = /text\/html/i.test(a.contentType ?? "") || /^\s*<(?:!doctype|html)/i.test(a.text);
  return html ? { file: null, verdict: { ...base, status: "no_robots", reason: null } } : { file: parseRobots(a.text), verdict: null };
}

/** The verdict for one path under a parsed (or absent) robots.txt for our token. */
export function verdictFor(file: RobotsFile | null, pathAndQuery: string, token = ROBOTS_PRODUCT_TOKEN): RobotsVerdict {
  if (!file) return { status: "no_robots", rule: null, crawlDelaySec: null, reason: null, sitemaps: [], contact: null, identityRefused: false };
  const group = groupFor(file, token);
  const d = decidePath(group, pathAndQuery);
  return { status: d.allowed ? "allowed" : "disallowed", rule: d.rule, crawlDelaySec: group?.crawlDelaySec ?? null, reason: null, sitemaps: file.sitemaps, contact: file.contact, identityRefused: false };
}

/** The gap to keep between two requests to a host: our floor, raised to the host's Crawl-delay. */
export const gapMsFor = (v: Pick<RobotsVerdict, "crawlDelaySec"> | null | undefined): number => Math.max(MIN_HOST_GAP_MS, Math.round((v?.crawlDelaySec ?? 0) * 1000));

/**
 * The robots gate: one robots.txt read per origin, kept for the run (or for `life.ttlMs` where a process outlives a run), then a verdict for every URL asked about. `read` fetches robots.txt itself (it must not ask this gate again).
 * A host that cannot be read stays `unknown` for the run; a later run asks again.
 */
export function makeRobotsGate(read: (robotsUrl: string) => Promise<RobotsAnswer>, token = ROBOTS_PRODUCT_TOKEN, life?: { now: () => number; ttlMs: number }): (url: string) => Promise<RobotsVerdict> {
  const byOrigin = new Map<string, { at: number; read: Promise<ReturnType<typeof interpretRobotsAnswer>> }>();
  return async (url) => {
    const u = new URL(url);
    if (u.pathname === "/robots.txt") return verdictFor(null, "/", token);
    const at = life?.now() ?? 0;
    let held = byOrigin.get(u.origin);
    if (!held || (life && at - held.at > life.ttlMs)) {
      held = { at, read: read(`${u.origin}/robots.txt`).then(interpretRobotsAnswer, (e: unknown) => interpretRobotsAnswer({ status: null, text: "", error: e instanceof Error ? e.message : String(e) })) };
      byOrigin.set(u.origin, held);
    }
    const { file, verdict } = await held.read;
    return verdict ?? verdictFor(file, `${u.pathname}${u.search}`, token);
  };
}
