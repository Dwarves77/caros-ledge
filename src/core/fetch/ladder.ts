// Ported from old_repo/src/lib/sources/transport-escalation.mjs (lines 86-256)
// Ported from old_repo/src/lib/sources/transport-runtime.mjs (lines 1-95)
import { apiEndpointFor } from "./api";
import { BODY_CLASS, classifyBody, isStorableClass, type BodyClass } from "./classify-body";
import { type TransportResult } from "./direct";
import transportOrder from "./data/transport-order.json";

const RENDER_FIRST_HOSTS = new RegExp(transportOrder.renderFirstHosts, "i");
/** The ladder's own class beside the body classes: the headless tier ran nowhere (off the Actions runner). */
export const NEEDS_HEADLESS = "needs_headless" as const;
export type AttemptClass = BodyClass | typeof NEEDS_HEADLESS;
export type TransportName = "cache" | "api" | "direct" | "headless";
export type LadderOutcome = "content" | "seek_more" | "no_reachable_source";

const NOT_FOUND = new Set<AttemptClass>([BODY_CLASS.NOT_FOUND, BODY_CLASS.SOFT_404]);
const isOk = (c: AttemptClass): boolean => c !== NEEDS_HEADLESS && isStorableClass(c);

/** Ordered transports for a URL: API hosts route to the API first; hosts a plain GET is walled from try the headless tier first; else direct, then headless. */
export function selectTransportOrder(url: string): Array<"api" | "direct" | "headless"> {
  if (apiEndpointFor(url)) return ["api", "direct", "headless"];
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return ["direct", "headless"];
  }
  return RENDER_FIRST_HOSTS.test(host) ? ["headless", "direct"] : ["direct", "headless"];
}

export interface Attempt {
  url: string;
  transport: TransportName;
  class: AttemptClass;
  verdict: "content" | "not_found" | "js_shell" | "block" | "needs_headless";
  status: number | undefined;
  bytes: number;
  reason: AttemptClass | null;
}
export interface LadderVerdict {
  outcome: LadderOutcome;
  /** The write-side guarantee: only real content is ever stored; an error body never is. */
  storeRow: boolean;
  text: string;
  transport: TransportName | "none";
  /** One row per (candidate x transport) tried: the exhaustion record. */
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
}
type Maybe<T> = T | null | undefined | Promise<T | null | undefined>;
export interface LadderDeps {
  cacheGet?: (url: string) => Maybe<{ text?: string }>;
  apiFetch?: (url: string) => Maybe<TransportResult>;
  directFetch?: (url: string) => Maybe<TransportResult>;
  headlessFetch?: (url: string) => Maybe<TransportResult>;
  seekMore?: (url: string) => unknown;
  /** The cap reported when a winning transport does not carry its own. */
  max?: number;
}

function labelOf(cls: AttemptClass): Attempt["verdict"] {
  if (isOk(cls)) return "content";
  if (cls === NEEDS_HEADLESS) return "needs_headless";
  if (NOT_FOUND.has(cls)) return "not_found";
  return cls === BODY_CLASS.JS_SHELL ? "js_shell" : "block";
}

/**
 * The escalation ladder at the single primitive (INV-178). Each candidate URL is tried through the cache, the API for API hosts, then the HTML
 * transports in host order; the first content success wins. A JS shell from the direct transport escalates to the headless tier; a headless
 * tier that cannot run records needs_headless. Every attempt lands in the exhaustion record. An error body is never returned as content.
 */
export async function escalateFetch(urls: string | string[], deps: LadderDeps = {}): Promise<LadderVerdict> {
  const candidates = (Array.isArray(urls) ? urls : [urls]).filter((u): u is string => typeof u === "string" && !!u);
  const attempts: Attempt[] = [];
  const rich = new Map<string, TransportResult>();
  const max = deps.max ?? 0;
  const note = (url: string, transport: TransportName, res: { status?: number; text?: string; needsHeadless?: boolean }): AttemptClass => {
    const cls: AttemptClass = res.needsHeadless ? NEEDS_HEADLESS : classifyBody(res.text ?? "", { status: res.status ?? 200 }).class;
    attempts.push({ url, transport, class: cls, verdict: labelOf(cls), status: res.status, bytes: typeof res.text === "string" ? res.text.length : 0, reason: isOk(cls) ? null : cls });
    return cls;
  };
  const done = (outcome: LadderOutcome, extra: Partial<LadderVerdict>): LadderVerdict => {
    const last = attempts[attempts.length - 1];
    const lastRich = last ? rich.get(`${last.url}|${last.transport}`) : undefined;
    return { outcome, storeRow: outcome === "content", text: outcome === "content" ? (extra.text ?? "") : "", transport: extra.transport ?? "none", attempts, seekMoreTask: extra.seekMoreTask ?? null, holdReason: extra.holdReason ?? null, url: extra.url, truncated: extra.truncated ?? false, fullLength: extra.fullLength ?? (extra.text?.length ?? 0), cap: extra.cap ?? max, reason: outcome === "content" ? null : (last?.class ?? null), lastFailureText: outcome === "content" ? "" : (lastRich?.text ?? "") };
  };
  const win = (url: string, transport: TransportName, res: TransportResult | { text?: string }): LadderVerdict => {
    const r = res as TransportResult;
    return done("content", { url, text: r.text ?? "", transport, truncated: !!r.truncated, fullLength: r.fullLength ?? r.text?.length ?? 0, cap: r.cap ?? max });
  };

  let notFoundSeen = false;
  for (const url of candidates) {
    if (deps.cacheGet) {
      const hit = await deps.cacheGet(url);
      if (hit?.text && isOk(note(url, "cache", hit))) return win(url, "cache", hit);
    }
    if (apiEndpointFor(url) && deps.apiFetch) {
      const res = await deps.apiFetch(url);
      if (res) {
        rich.set(`${url}|api`, res);
        if (isOk(note(url, "api", res))) return win(url, "api", res);
      }
    }
    const impl = { direct: deps.directFetch, headless: deps.headlessFetch };
    const queue = selectTransportOrder(url).filter((t): t is "direct" | "headless" => t !== "api");
    const tried = new Set<string>();
    while (queue.length) {
      const t = queue.shift() as "direct" | "headless";
      const fn = impl[t];
      if (tried.has(t) || !fn) continue;
      tried.add(t);
      const res = (await fn(url)) ?? { status: 0, text: "", truncated: false, fullLength: 0, cap: max };
      rich.set(`${url}|${t}`, res);
      const cls = note(url, t, res);
      if (isOk(cls)) return win(url, t, res);
      if (NOT_FOUND.has(cls)) notFoundSeen = true;
      if (cls === BODY_CLASS.JS_SHELL && impl.headless && !tried.has("headless") && !queue.includes("headless")) queue.push("headless");
    }
  }
  const seed = candidates[0];
  if (notFoundSeen) return done("seek_more", { url: seed, seekMoreTask: deps.seekMore ? await deps.seekMore(seed ?? "") : { kind: "seek_more_alternate_url", url: seed } });
  return done("no_reachable_source", { url: seed, holdReason: "NO_REACHABLE_SOURCE" });
}

/**
 * The write-side capture verdict (INV-178): what may be STORED as source content. A capture is excluded when the body classifier calls it
 * anything but real content (an error body, a wall, an interface shell, furniture). When nothing usable remains from a non-empty input the
 * item holds NO_REACHABLE_SOURCE. The excluded set is returned for the caller to surface, never silently dropped.
 */
export function captureForStorage<T extends { text: string }>(fetched: readonly T[] | null | undefined): { store: T[]; excluded: T[]; holdReason: string | null } {
  const store: T[] = [];
  const excluded: T[] = [];
  for (const b of fetched ?? []) (isStorableClass(classifyBody(b?.text ?? "").class) ? store : excluded).push(b);
  return { store, excluded, holdReason: store.length === 0 && (fetched?.length ?? 0) > 0 ? "NO_REACHABLE_SOURCE" : null };
}
