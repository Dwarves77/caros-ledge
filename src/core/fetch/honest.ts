// Ported from old_repo/src/lib/sources/sec-fair-access.ts (lines 1-11)
// The Node side of the one fetch primitive: a GET under the declared identity (the SEC fair-access string for sec.gov), the address check on every hop, the robots verdict of every URL and the per-host gap.
// One kit per raw fetch function, so the robots cache (an hour) and the host gate hold across every transport.
import { lookup } from "node:dns/promises";

import type { FetchDeps } from "./direct";
import { guardedFetch, makeHostGate, makeRobotsReader, type GuardOptions } from "./guard";
import { licenceForbidsHost } from "./licence-hosts";
import { pinnedFetch } from "./pin";
import { BOT_USER_AGENT, readBodyCapped } from "./policy";
import { makeRobotsGate } from "./robots";

export type RobotsGate = ReturnType<typeof makeRobotsGate>;
export type HonestDeps = Pick<FetchDeps, "fetchImpl" | "env" | "now" | "sleep" | "resolveHost">;
interface Kit {
  /** The guard without a robots check (a publisher's documented API) and the run's robots gate. */
  base: Omit<GuardOptions, "userAgent" | "robots">;
  robots: RobotsGate;
}
/** One kit per raw fetch function (the global one, or the one a run injects), so the robots cache and the host gap hold across every transport and every spread copy of the deps. */
const kits = new WeakMap<object, Kit>();
const ROBOTS_TTL_MS = 60 * 60 * 1000;

/** The declared User-Agent SEC fair access requires for sec.gov; null for any other host or an unset contact. */
function secFairAccessUaForUrl(url: string, env: Record<string, string | undefined> = process.env): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host !== "sec.gov" && !host.endsWith(".sec.gov")) return null;
  const ua = env.SEC_FAIR_ACCESS_UA;
  return ua && ua.trim().length > 0 ? ua : null;
}

/** The addresses of a host, asked fresh every time (no cache: the answer the guard vets is the one the request is pinned to, for that one fetch). `lookupImpl` is the resolver (dns.lookup by default). */
const nodeResolve = (host: string, lookupImpl: typeof lookup = lookup): Promise<string[]> => lookupImpl(host, { all: true }).then((all) => all.map((a) => a.address));
/** The resolver a run uses: the injected one, else the system's. The browser tier's route guard asks the same. */
export const resolverFor = (deps: Pick<HonestDeps, "resolveHost">): ((host: string) => Promise<string[]>) => deps.resolveHost ?? nodeResolve;

function kitFor(deps: HonestDeps): Kit {
  const raw = deps.fetchImpl ?? fetch;
  const held = kits.get(raw);
  if (held) return held;
  const now = () => (deps.now ? deps.now().getTime() : performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base: Omit<GuardOptions, "userAgent" | "robots"> = { licence: licenceForbidsHost, fetchImpl: raw, resolveHost: resolverFor(deps), fetchPinned: pinnedFetch(raw), gate: makeHostGate({ now, sleep }), upgradeHttp: true };
  const robots = makeRobotsGate(makeRobotsReader({ ...base, userAgent: BOT_USER_AGENT }, readBodyCapped), undefined, { now, ttlMs: ROBOTS_TTL_MS });
  const kit = { base, robots };
  kits.set(raw, kit);
  return kit;
}

/** The robots gate of a run, for the browser tier and the ladder to ask the same cached verdicts. */
export const robotsGateFor = (deps: HonestDeps): RobotsGate => kitFor(deps).robots;

/**
 * A fetch that is the one primitive: use it wherever a transport would call `fetch`. `api: true` is a publisher's documented API endpoint: robots.txt governs crawlers of pages, an API is offered for automated
 * use under its own terms, so only the robots check is skipped; the identity, the address check and the host gap still apply.
 */
export function honestFetch(deps: HonestDeps, opts: { api?: boolean } = {}): typeof fetch {
  const kit = kitFor(deps);
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return guardedFetch(url, init ?? {}, { ...kit.base, ...(opts.api ? {} : { robots: kit.robots }), userAgent: secFairAccessUaForUrl(url, deps.env) ?? BOT_USER_AGENT });
  };
}
