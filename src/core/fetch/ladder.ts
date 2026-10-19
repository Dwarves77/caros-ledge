// Ported from old_repo/src/lib/sources/transport-escalation.mjs (lines 86-256)
// Ported from old_repo/src/lib/sources/transport-runtime.mjs (lines 1-95)
import { apiEndpointFor } from "./api";
import { BODY_CLASS, classifyBody, isStorableClass, type BodyClass } from "./classify-body";
import { type TransportResult } from "./direct";
import type { RefusalReason } from "./policy";

/** The ladder's own classes beside the body classes: the browser tier ran nowhere, or a policy refused a channel before or after it ran. */
const NEEDS_HEADLESS = "needs_headless" as const;
const POLICY_CLASSES = ["robots_disallowed", "robots_unknown", "paywalled", "interactive_challenge", "gated", "private_address", "host_busy"] as const;
type PolicyClass = (typeof POLICY_CLASSES)[number];
export type AttemptClass = BodyClass | typeof NEEDS_HEADLESS | PolicyClass;
/** A channel name is the transport of an attempt: api, feed, sitemap, direct, browser, substitute (and the in-run cache). */
export type TransportName = "cache" | "api" | "feed" | "sitemap" | "direct" | "browser" | "substitute";
export type LadderOutcome = "content" | "seek_more" | "no_reachable_source" | "access_requested" | "deferred";

const NOT_FOUND = new Set<AttemptClass>([BODY_CLASS.NOT_FOUND, BODY_CLASS.SOFT_404]);
/** A wall: the host declined this transport. Final for it; the next channel is tried, never another identity. */
const WALLS = new Set<AttemptClass>([BODY_CLASS.HTTP_403, BODY_CLASS.BOT_WALL, BODY_CLASS.CDN_BLOCK, BODY_CLASS.REQUEST_ACCESS, BODY_CLASS.INTERACTIVE_CHALLENGE, "robots_disallowed", "gated"]);
/** Not a refusal and not an answer: tried again on a later run. */
const DEFERRALS = new Set<AttemptClass>(["robots_unknown", "host_busy"]);
const isOk = (c: AttemptClass): boolean => c !== NEEDS_HEADLESS && !POLICY_CLASSES.includes(c as PolicyClass) && isStorableClass(c as BodyClass);
const isPolicy = (r: string | undefined): r is PolicyClass => !!r && (POLICY_CLASSES as readonly string[]).includes(r);

export interface Attempt {
  url: string;
  /** The channel that was tried. */
  transport: TransportName;
  class: AttemptClass;
  verdict: "content" | "not_found" | "js_shell" | "block" | "needs_headless" | "refused" | "deferred" | "discovery";
  status: number | undefined;
  bytes: number;
  reason: AttemptClass | null;
  /** The robots.txt rule or the guard sentence behind a policy class. */
  detail?: string;
}
export interface LadderVerdict {
  outcome: LadderOutcome;
  /** The write-side guarantee: only real content is ever stored; an error body never is. */
  storeRow: boolean;
  text: string;
  transport: TransportName | "none";
  /** One row per (candidate x channel) tried: the exhaustion record. */
  attempts: Attempt[];
  seekMoreTask: unknown;
  holdReason: string | null;
  url: string | undefined;
  truncated: boolean;
  fullLength: number;
  cap: number;
  /** The class of the last failed attempt (non-content outcomes). */
  reason: AttemptClass | null;
  lastFailureText: string;
  /** The winning channel's whole result (its markup included when the channel carried it), for the writer of the capture; null unless content. */
  result: TransportResult | null;
  /** The host a substitute publisher served from, and its registry id when the caller registered it. */
  substitute: { host: string; publisherId: string; url: string } | null;
  /** For access_requested: the contact the publisher publishes (null when none), and the robots.txt rule when robots was the cause. */
  access: { contact: string | null; rule: string | null } | null;
}
type Maybe<T> = T | null | undefined | Promise<T | null | undefined>;
export interface SourceChannels {
  api_endpoint_url?: string | null;
  rss_feed_url?: string | null;
  sitemap_url?: string | null;
  access_method?: string | null;
  paywalled?: boolean;
}
export interface SubstituteHit {
  url: string;
  host: string;
  publisherId: string;
  result: TransportResult;
}
export interface LadderDeps {
  /** Every rung is a member of the ladder; a rung the caller does not run is a typed null, never an omission. */
  cacheGet: ((url: string) => Maybe<{ text?: string }>) | null;
  apiFetch: ((url: string) => Maybe<TransportResult>) | null;
  /** Read the source's registered feed (R2c C3). */
  feedFetch: ((feedUrl: string) => Maybe<TransportResult>) | null;
  /** Look the URL up in the source's registered sitemap: a discovery channel, it never yields content. */
  sitemapProbe: ((sitemapUrl: string, url: string) => Maybe<{ status: number; listed: boolean }>) | null;
  directFetch: ((url: string) => Maybe<TransportResult>) | null;
  browserFetch: ((url: string) => Maybe<TransportResult>) | null;
  /** Resolve the item at the next official publisher by its identifier (src/core/sources/publishers.ts); the hits carry their own result. */
  substituteFetch: ((url: string) => Promise<SubstituteHit[]>) | null;
  /** The contact a publisher publishes, for an access request. */
  contactOf: ((url: string) => Promise<{ contact: string | null; rule: string | null }>) | null;
  seekMore: ((url: string) => unknown) | null;
  /** The cap reported when a winning channel does not carry its own. */
  max: number;
  /** The source row's registered alternatives and flags; null means a bare URL. */
  source: SourceChannels | null;
  /** Channels not to try (the capture worker already did direct). */
  skip: readonly TransportName[];
}

function labelOf(cls: AttemptClass): Attempt["verdict"] {
  if (isOk(cls)) return "content";
  if (cls === NEEDS_HEADLESS) return "needs_headless";
  if (NOT_FOUND.has(cls)) return "not_found";
  if (DEFERRALS.has(cls)) return "deferred";
  if (isPolicy(cls)) return "refused";
  return cls === BODY_CLASS.JS_SHELL ? "js_shell" : "block";
}

/**
 * The escalation ladder at the single primitive (INV-178). Per candidate URL: the cache; then the channels in order (a source whose access method is api or rss reads that declared channel first, every other source after its direct GET refused);
 * the direct GET under the declared identity; the source's other registered channels; the browser tier (only where the refusal is a wall or a script shell, never after a robots refusal); a substitute publisher by identifier.
 * The first content success wins. A 403, 429 or challenge is final for its channel and the next is tried. Every attempt lands in the exhaustion record under its channel name. A source reaches `access_requested` only after every channel
 * has been tried and at least one refused; a robots.txt that could not be read, or a host that asked for a long gap, is `deferred`, never denied. An error body is never returned as content.
 */
export async function escalateFetch(urls: string | string[], deps: LadderDeps): Promise<LadderVerdict> {
  const candidates = (Array.isArray(urls) ? urls : [urls]).filter((u): u is string => typeof u === "string" && !!u);
  const attempts: Attempt[] = [];
  const rich = new Map<string, TransportResult>();
  const max = deps.max;
  const skip = new Set<TransportName>(deps.skip);
  const src = deps.source;
  const note = (url: string, transport: TransportName, res: { status?: number; text?: string; needsHeadless?: boolean; refusal?: { reason: RefusalReason; detail: string } | null }): AttemptClass => {
    const cls: AttemptClass = res.needsHeadless ? NEEDS_HEADLESS : isPolicy(res.refusal?.reason) ? res.refusal.reason : classifyBody(res.text ?? "", { status: res.status ?? 200 }).class;
    attempts.push({ url, transport, class: cls, verdict: labelOf(cls), status: res.status, bytes: typeof res.text === "string" ? res.text.length : 0, reason: isOk(cls) ? null : cls, ...(isPolicy(cls) && res.refusal ? { detail: res.refusal.detail } : {}) });
    return cls;
  };
  const done = (outcome: LadderOutcome, extra: Partial<LadderVerdict>): LadderVerdict => {
    const last = [...attempts].reverse().find((a) => a.transport !== "sitemap");
    const lastRich = last ? rich.get(`${last.url}|${last.transport}`) : undefined;
    return { outcome, storeRow: outcome === "content", text: outcome === "content" ? (extra.text ?? "") : "", transport: extra.transport ?? "none", attempts, seekMoreTask: extra.seekMoreTask ?? null, holdReason: extra.holdReason ?? null, url: extra.url, truncated: extra.truncated ?? false, fullLength: extra.fullLength ?? (extra.text?.length ?? 0), cap: extra.cap ?? max, reason: outcome === "content" ? null : (last?.class ?? null), lastFailureText: outcome === "content" ? "" : (lastRich?.text ?? ""), result: extra.result ?? null, substitute: extra.substitute ?? null, access: extra.access ?? null };
  };
  const win = (url: string, transport: TransportName, res: TransportResult | { text?: string }, extra: Partial<LadderVerdict> = {}): LadderVerdict => {
    const r = res as TransportResult;
    return done("content", { url, result: r as TransportResult, text: r.text ?? "", transport, truncated: !!r.truncated, fullLength: r.fullLength ?? r.text?.length ?? 0, cap: r.cap ?? max, ...extra });
  };
  /** Try one channel; returns the verdict when it served. */
  const tryChannel = async (url: string, transport: TransportName, call: (() => Maybe<TransportResult>) | undefined, target = url): Promise<{ won: LadderVerdict | null; cls: AttemptClass | null }> => {
    if (!call || skip.has(transport)) return { won: null, cls: null };
    const res = (await call()) ?? { status: 0, text: "", truncated: false, fullLength: 0, cap: max };
    rich.set(`${url}|${transport}`, res);
    const cls = note(target, transport, res);
    return { won: isOk(cls) ? win(url, transport, res) : null, cls };
  };

  let notFoundSeen = false;
  for (const url of candidates) {
    if (deps.cacheGet) {
      const hit = await deps.cacheGet(url);
      if (hit?.text && isOk(note(url, "cache", hit))) return win(url, "cache", hit);
    }
    const apiUrl = src?.api_endpoint_url ?? (apiEndpointFor(url) ? url : null);
    const feedUrl = src?.rss_feed_url ?? null;
    const apiCall = apiUrl && deps.apiFetch ? () => deps.apiFetch?.(apiUrl) : undefined;
    const feedCall = feedUrl && deps.feedFetch ? () => deps.feedFetch?.(feedUrl) : undefined;
    const declaredFirst = !!src?.api_endpoint_url || !!apiEndpointFor(url) || src?.access_method === "api" || src?.access_method === "rss";
    const steps: Array<[TransportName, (() => Maybe<TransportResult>) | undefined]> = declaredFirst
      ? [["api", apiCall], ["feed", feedCall], ["direct", deps.directFetch ? () => deps.directFetch?.(url) : undefined]]
      : [["direct", deps.directFetch ? () => deps.directFetch?.(url) : undefined], ["api", apiCall], ["feed", feedCall]];
    let direct: AttemptClass | null = null;
    for (const [t, call] of steps) {
      const r = await tryChannel(url, t, call, t === "feed" ? (feedUrl as string) : t === "api" && src?.api_endpoint_url ? src.api_endpoint_url : url);
      if (r.won) return r.won;
      if (t === "direct") direct = r.cls;
      if (r.cls && NOT_FOUND.has(r.cls) && t === "direct") notFoundSeen = true;
    }
    if (src?.sitemap_url && deps.sitemapProbe && !skip.has("sitemap")) {
      const p = (await deps.sitemapProbe(src.sitemap_url, url)) ?? { status: 0, listed: false };
      attempts.push({ url: src.sitemap_url, transport: "sitemap", class: BODY_CLASS.EMPTY, verdict: "discovery", status: p.status, bytes: 0, reason: null, detail: p.listed ? "listed in the registered sitemap (discovery only: a sitemap carries no content)" : "not listed in the registered sitemap" });
    }
    const refusedByRobots = attempts.some((a) => a.url === url && a.class === "robots_disallowed");
    const escalate = direct === null || WALLS.has(direct) || direct === "robots_unknown" || direct === BODY_CLASS.JS_SHELL || direct === BODY_CLASS.EMPTY || direct === BODY_CLASS.ERROR_BODY;
    if (escalate && !NOT_FOUND.has(direct as AttemptClass)) {
      if (refusedByRobots) attempts.push({ url, transport: "browser", class: "robots_disallowed", verdict: "refused", status: 0, bytes: 0, reason: "robots_disallowed", detail: "not run: the browser tier honours robots.txt, which disallows this URL" });
      else {
        const r = await tryChannel(url, "browser", deps.browserFetch ? () => deps.browserFetch?.(url) : undefined);
        if (r.won) return r.won;
      }
    }
    if (deps.substituteFetch && !skip.has("substitute")) {
      for (const hit of await deps.substituteFetch(url)) {
        const cls = note(hit.url, "substitute", hit.result);
        rich.set(`${url}|substitute`, hit.result);
        if (isOk(cls)) return win(url, "substitute", hit.result, { substitute: { host: hit.host, publisherId: hit.publisherId, url: hit.url } });
      }
    }
  }
  const seed = candidates[0];
  const refusals = attempts.filter((a) => WALLS.has(a.class));
  if (attempts.some((a) => DEFERRALS.has(a.class))) return done("deferred", { url: seed, holdReason: "DEFERRED" });
  // The browser tier did not run (off the Actions runner): the ladder is not exhausted, so nothing is requested of the publisher yet.
  if (attempts.some((a) => a.class === NEEDS_HEADLESS)) return done("deferred", { url: seed, holdReason: "NEEDS_BROWSER" });
  if (refusals.length && !notFoundSeen) {
    const published = deps.contactOf && seed ? await deps.contactOf(seed) : { contact: null, rule: null };
    return done("access_requested", { url: seed, holdReason: "ACCESS_REQUESTED", access: { contact: published.contact, rule: refusals.find((a) => a.class === "robots_disallowed")?.detail?.match(/\(([^)]*)\)/)?.[1] ?? published.rule } });
  }
  if (notFoundSeen) return done("seek_more", { url: seed, seekMoreTask: deps.seekMore ? await deps.seekMore(seed ?? "") : { kind: "seek_more_alternate_url", url: seed } });
  return done("no_reachable_source", { url: seed, holdReason: "NO_REACHABLE_SOURCE" });
}

