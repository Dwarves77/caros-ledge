// New in the 2026-10-23 security pass (audit row 2.3.14): no old counterpart.
// The Node side of "connect to the vetted address". The guard resolves a host name once and vets every address; this builds the undici Agent whose connect lookup answers with exactly that list, so the socket layer never asks DNS
// again and a name that rebinds between the check and the connect cannot reach a private address. The URL is untouched, so the Host header and the TLS server name (SNI) stay the host name.
import { isIP } from "node:net";

import { Agent, type buildConnector } from "undici";

type Callback = (err: NodeJS.ErrnoException | null, addressOrList?: string | Array<{ address: string; family: number }>, family?: number) => void;

/** A `lookup` for a socket connect that returns the vetted addresses and resolves nothing: both shapes the socket layer asks for (`all` and single). An empty list is an unresolvable name (ENOTFOUND). */
function pinnedLookup(addresses: readonly string[]): (hostname: string, options: { all?: boolean }, cb: Callback) => void {
  const list = addresses.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
  return (hostname, options, cb) => {
    if (list.length === 0) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", hostname }));
    if (options?.all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  };
}

/** An Agent that connects only to `addresses` for any host name it is asked to open. One per request: the vetted answer lives for one fetch. `tls` is extra connect options (a test's CA). */
function pinnedAgent(addresses: readonly string[], tls: Partial<buildConnector.BuildOptions>): Agent {
  return new Agent({ connect: { ...tls, lookup: pinnedLookup(addresses) } as buildConnector.BuildOptions });
}

/** A `fetchPinned` for the guard over a raw fetch: the request goes through a fresh pinned Agent, closed once its response is done (gracefully, so a streaming body finishes) and destroyed if the request fails. */
export function pinnedFetch(raw: typeof fetch, tls: Partial<buildConnector.BuildOptions> = {}): (url: string, init: RequestInit, vetted: readonly string[]) => Promise<Response> {
  return async (url, init, vetted) => {
    const agent = pinnedAgent(vetted, tls);
    try {
      const res = await raw(url, { ...init, dispatcher: agent } as RequestInit);
      void agent.close().catch(() => undefined);
      return res;
    } catch (e) {
      void agent.destroy().catch(() => undefined);
      throw e;
    }
  };
}
