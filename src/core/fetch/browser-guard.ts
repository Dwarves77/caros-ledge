// New in the 2026-10-23 security pass (audit row 2.3.15): no old counterpart.
// The browser tier's address check. Chromium follows redirects and loads every subresource itself, so the guard that checks each hop of a plain GET cannot see them; this installs it where they pass: a route handler on the
// browser context that resolves each request's host through the run's resolver and the guard's own check (assertPublicHost) and aborts anything that is not a public http(s) address, plus a record of every response (its host,
// and the address Chromium actually connected to) so a hop that left the vetted set refuses the capture even if an interception was missed. A second layer is in the browser itself: host-resolver rules that make the local
// and metadata names unresolvable.
import { assertPublicHost, isPrivateAddress } from "./guard";

/** The local and metadata names the browser cannot resolve at all (Chromium host-resolver rules). A second layer under the route handler, not a substitute for it. */
const HOST_RESOLVER_RULES = ["localhost", "*.localhost", "*.internal", "metadata.google.internal", "169.254.169.254"].map((h) => `MAP ${h} ~NOTFOUND`).join(", ");
/** The launch options of the run's Chromium: windowed when a display exists (see headless.ts), always with the host-resolver rules. */
export const browserLaunchOptions = (windowed: boolean): { headless: boolean; args: string[] } => ({ headless: !windowed, args: [`--host-resolver-rules=${HOST_RESOLVER_RULES}`] });

const VERDICT_TTL_MS = 60_000;

export interface GuardedRequest {
  url(): string;
  isNavigationRequest?(): boolean;
  redirectedFrom?(): unknown;
}
export interface RouteLike {
  request(): GuardedRequest;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}
export interface ResponseLike {
  url(): string;
  status(): number;
  serverAddr(): Promise<{ ipAddress: string; port: number } | null>;
}
export interface RouteGuard {
  /** The `context.route` handler: continue a public http(s) request, abort anything else. */
  handler(route: RouteLike): Promise<void>;
  /** Feed every response of a page here (page.on("response")): the record of redirects and of the address Chromium really connected to. */
  watch(response: ResponseLike): Promise<void>;
  /** Why the capture must be refused (a navigation or redirect hop blocked, a response from outside the vetted set); empty when nothing left it. Cleared by `reset`. */
  readonly violations: string[];
  /** Admit a URL by the same check (the page's final address). Returns the reason it is not admitted, or null. */
  check(url: string): Promise<string | null>;
  reset(): void;
}

/**
 * The route guard of one browser context. A host is checked once on first sight and the verdict held for 60 s (the allow set is per context, so the contexts of other hosts do not share it); after that it is asked again.
 * `resolveHost` is the run's resolver, the same one the plain GET is vetted with.
 */
export function makeRouteGuard(resolveHost: (host: string) => Promise<string[]>, now: () => number): RouteGuard {
  const verdicts = new Map<string, { at: number; why: Promise<string | null> }>();
  const violations: string[] = [];
  const chain: string[] = [];
  const check = async (raw: string): Promise<string | null> => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return `${raw} is not a URL`;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return `${url.protocol} is not fetched (only http and https)`;
    const held = verdicts.get(url.hostname);
    if (held && now() - held.at < VERDICT_TTL_MS) return held.why;
    const why = assertPublicHost(url, resolveHost).then(
      () => null,
      (e: unknown) => (e as { fetchRefusal?: { detail: string } } | null)?.fetchRefusal?.detail ?? `${url.hostname} could not be vetted`,
    );
    verdicts.set(url.hostname, { at: now(), why });
    return why;
  };
  return {
    violations,
    check,
    reset: () => {
      violations.length = 0;
      chain.length = 0;
    },
    async handler(route) {
      const req = route.request();
      const url = req.url();
      const why = await check(url);
      if (!why) return route.continue();
      // A blocked subresource is dropped and the page is read without it; a blocked navigation or redirect hop leaves the vetted set and refuses the capture.
      if (req.isNavigationRequest?.() || req.redirectedFrom?.()) violations.push(`${url} blocked: ${why}`);
      return route.abort("blockedbyclient");
    },
    async watch(response) {
      const url = response.url();
      if (response.status() >= 300 && response.status() < 400) chain.push(url);
      const hop = chain.length > 0 ? ` (redirect chain: ${[...chain, url].join(" -> ")})` : "";
      const why = await check(url);
      if (why) return void violations.push(`${url} answered${hop}: ${why}`);
      const addr = (await response.serverAddr().catch(() => null))?.ipAddress;
      if (addr && isPrivateAddress(addr)) violations.push(`${url} was served from ${addr}, a private, loopback or link-local address${hop}`);
    },
  };
}
