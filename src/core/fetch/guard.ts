// New in R2c: no old counterpart (the old tree followed redirects with no address check and sent a browser identity, register rows C:39 and D:49).
// The one fetch primitive's guard. Import-free, so the Edge Function (Deno) and the Node transports share it by relative path. Every GET goes through guardedFetch: the declared identity (never another), a refusal of private,
// loopback and link-local addresses before the first hop and after every redirect, the robots verdict of every URL asked, and the per-host gap. A refusal is a thrown FetchRefusalError that carries a typed reason.

export type GuardReason = "robots_disallowed" | "robots_unknown" | "private_address" | "bad_scheme" | "too_many_redirects" | "host_busy";
export interface GuardRefusal {
  reason: GuardReason;
  /** A transient refusal is retried on a later run (robots unknown, a host that asked for a long gap); a permanent one is recorded on the source. */
  transient: boolean;
  detail: string;
  /** The robots rule that matched, for robots_disallowed. */
  rule?: string;
  /** Milliseconds until the host may be asked again, for host_busy. */
  retryAfterMs?: number;
  /** For robots_unknown: the host answered robots.txt itself with 401, 403 or 429, so the declared identity was refused and the browser tier may re-read it as a person's browser would. */
  identityRefused?: boolean;
}
export class FetchRefusalError extends Error {
  readonly fetchRefusal: GuardRefusal;
  constructor(refusal: GuardRefusal) {
    super(refusal.detail);
    this.name = "FetchRefusalError";
    this.fetchRefusal = refusal;
  }
}
/** Type guard that also works across module copies (the Edge bundle and the Node tree each hold their own class). */
export const refusalOf = (e: unknown): GuardRefusal | null => ((e as { fetchRefusal?: GuardRefusal } | null)?.fetchRefusal ?? null);

const v4 = (s: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  const p = m ? m.slice(1).map(Number) : null;
  return p && p.every((n) => n <= 255) ? p : null;
};
function isPrivateV4(p: number[]): boolean {
  const [a = 0, b = 0, c = 0] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}
/** The 8 groups of an IPv6 literal, or null when it is not one. Handles `::`, an embedded IPv4 tail and a zone id. */
function groups6(addr: string): number[] | null {
  let s = addr.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const p = v4(tail[1] as string);
    if (!p) return null;
    s = `${s.slice(0, -(tail[1] as string).length)}${((p[0] as number) * 256 + (p[1] as number)).toString(16)}:${((p[2] as number) * 256 + (p[3] as number)).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2 || !/^[0-9a-f:]+$/.test(s)) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const all = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...rest];
  const nums = all.map((h) => parseInt(h, 16));
  return all.length === 8 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
}
/** Is this address (IPv4 or IPv6 literal) one a public crawler must never request: private, loopback, link-local, unique-local, multicast, documentation or reserved, including IPv4 mapped or translated into IPv6? An unparseable literal is refused. */
export function isPrivateAddress(addr: string): boolean {
  const four = v4(addr);
  if (four) return isPrivateV4(four);
  const g = groups6(addr);
  if (!g) return true;
  const [a = 0, b = 0] = g;
  if (g.every((n) => n === 0) || (g.slice(0, 7).every((n) => n === 0) && g[7] === 1)) return true;
  if ((a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0 || (a & 0xff00) === 0xff00) return true;
  if (a === 0x2001 && b === 0xdb8) return true;
  const embedded = (hi: number, lo: number) => isPrivateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return embedded(g[6] as number, g[7] as number);
  if (a === 0x64 && b === 0xff9b) return embedded(g[6] as number, g[7] as number);
  if (g.slice(0, 6).every((n) => n === 0)) return embedded(g[6] as number, g[7] as number);
  return false;
}
const NAME_REFUSED = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.localdomain|metadata|metadata\.google\.internal)$/i;

export interface GuardOptions {
  /** The one declared identity (BOT_USER_AGENT, or the SEC fair-access string for sec.gov); it replaces any user-agent a caller passed. */
  userAgent: string;
  fetchImpl?: typeof fetch;
  /** The addresses a host name resolves to (Node: dns.lookup all; Deno: Deno.resolveDns). Absent means a name is not resolved here: only literals and the reserved names are refused. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** The robots verdict for a URL; absent means robots.txt is not asked (only the robots reader itself runs that way). */
  robots?: (url: string) => Promise<{ status: "allowed" | "no_robots" | "disallowed" | "unknown"; rule: string | null; reason: string | null; crawlDelaySec: number | null; identityRefused?: boolean }>;
  /** Wait for the host's turn: resolves when a request may go, or returns a positive wait that is too long to sleep (the caller defers). */
  gate?: (host: string, crawlDelaySec: number | null) => Promise<void>;
  maxRedirects?: number;
  /** Rewrite an http Location to https (Cellar's 303 points at plain http). */
  upgradeHttp?: boolean;
}

/** Throw a private_address refusal when the URL's host is a private literal, a reserved name, or resolves to any private address. */
export async function assertPublicHost(url: URL, resolveHost?: GuardOptions["resolveHost"]): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const refuse = (why: string) => new FetchRefusalError({ reason: "private_address", transient: false, detail: `refused ${url.origin}: ${why}` });
  if (v4(host) || host.includes(":")) {
    if (isPrivateAddress(host)) throw refuse(`${host} is a private, loopback or link-local address`);
    return;
  }
  if (NAME_REFUSED.test(host)) throw refuse(`${host} is a reserved local name`);
  if (!resolveHost) return;
  // A name that cannot be resolved cannot be connected to: the request then fails with the network's own error. Only an answer that names a private address is a refusal.
  const addrs = await resolveHost(host).then((a) => a, () => [] as string[]);
  const bad = addrs.find((a) => isPrivateAddress(a));
  if (bad) throw refuse(`${host} resolves to ${bad}, a private, loopback or link-local address`);
}

/**
 * A GET (or HEAD) under the guard. Redirects are followed by hand so each hop is checked: scheme, address, robots, gap. The response's `url` is the last hop. The caller's user-agent is replaced by the declared one.
 * Throws FetchRefusalError for a guard refusal; any other error is the network's own.
 */
export async function guardedFetch(input: string, init: RequestInit, g: GuardOptions): Promise<Response> {
  const doFetch = g.fetchImpl ?? fetch;
  const max = g.maxRedirects ?? 10;
  let current = input;
  for (let hop = 0; hop <= max; hop++) {
    const url = new URL(current);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new FetchRefusalError({ reason: "bad_scheme", transient: false, detail: `refused ${url.protocol} (only http and https are fetched)` });
    await assertPublicHost(url, g.resolveHost);
    let delay: number | null = null;
    if (g.robots) {
      const v = await g.robots(current);
      if (v.status === "disallowed") throw new FetchRefusalError({ reason: "robots_disallowed", transient: false, detail: `robots.txt of ${url.host} disallows ${url.pathname}${v.rule ? ` (${v.rule})` : ""}`, ...(v.rule ? { rule: v.rule } : {}) });
      if (v.status === "unknown") throw new FetchRefusalError({ reason: "robots_unknown", transient: true, detail: `robots.txt of ${url.host} could not be read (${v.reason ?? "unknown"}): deferred, not denied`, ...(v.identityRefused ? { identityRefused: true } : {}) });
      delay = v.crawlDelaySec;
    }
    if (g.gate) await g.gate(url.host, delay);
    const headers = new Headers(init.headers);
    headers.set("User-Agent", g.userAgent);
    const res = await doFetch(current, { ...init, headers, redirect: "manual" });
    const location = res.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      if (hop === max) break;
      const next = new URL(location, current);
      if (g.upgradeHttp && next.protocol === "http:") next.protocol = "https:";
      await res.body?.cancel();
      current = next.toString();
      continue;
    }
    Object.defineProperty(res, "url", { value: current, configurable: true });
    return res;
  }
  throw new FetchRefusalError({ reason: "too_many_redirects", transient: false, detail: `more than ${max} redirects from ${input}` });
}

/** The per-host gate: requests to one host are at least `minGapMs` apart (raised to the host's Crawl-delay); a wait longer than `maxWaitMs` is returned as a refusal to defer, never slept. */
export function makeHostGate({ minGapMs = 1000, maxWaitMs = 20_000, now, sleep }: { minGapMs?: number; maxWaitMs?: number; now: () => number; sleep: (ms: number) => Promise<void> }): NonNullable<GuardOptions["gate"]> {
  const next = new Map<string, number>();
  return async (host, crawlDelaySec) => {
    const gap = Math.max(minGapMs, Math.round((crawlDelaySec ?? 0) * 1000));
    const wait = (next.get(host) ?? 0) - now();
    if (wait > maxWaitMs) throw new FetchRefusalError({ reason: "host_busy", transient: true, detail: `${host} asked for ${gap} ms between requests; the next turn is ${wait} ms away: deferred`, retryAfterMs: wait });
    if (wait > 0) await sleep(wait);
    next.set(host, Math.max(now(), next.get(host) ?? 0) + gap);
  };
}

/** The reader a robots gate calls for `<origin>/robots.txt`: the same guard (identity, address check, gap) but no robots check on itself. A guard refusal is thrown to the gate, which reports the host `unknown`. */
export function makeRobotsReader(g: Omit<GuardOptions, "robots">): (robotsUrl: string) => Promise<{ status: number; text: string; contentType: string | null }> {
  return async (robotsUrl) => {
    const res = await guardedFetch(robotsUrl, { headers: { Accept: "text/plain,*/*;q=0.5" }, signal: AbortSignal.timeout(20_000) }, g);
    const bytes = new Uint8Array(await res.arrayBuffer()).subarray(0, 512 * 1024);
    return { status: res.status, text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), contentType: res.headers.get("content-type") };
  };
}
