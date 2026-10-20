// Network stand-ins for the fetch tests (R2c): every transport asks robots.txt before a page, so a fake that answers one body for every URL would answer robots.txt with a page.
// `routed` answers /robots.txt from a table (default: 404, no file) and every other URL from the handler; `calls` counts only the page requests. `instant` is a sleep that returns at once, so the per-host gap never costs a test a second.
export const instant = async (): Promise<void> => undefined;

export interface Routed {
  fetch: typeof fetch;
  /** Page requests (everything but robots.txt), in order. */
  calls: string[];
  /** User-agent header of every request, robots.txt included. */
  agents: string[];
  robots: Map<string, { status: number; body?: string }>;
}
export function routed(handler: (url: string, init: RequestInit) => Response | Promise<Response>, robots: Record<string, { status: number; body?: string }> = {}): Routed {
  const table = new Map(Object.entries(robots));
  const out: Routed = {
    calls: [],
    agents: [],
    robots: table,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      out.agents.push(new Headers(init?.headers).get("user-agent") ?? "");
      const u = new URL(url);
      if (u.pathname === "/robots.txt") {
        const r = table.get(u.host) ?? { status: 404 };
        return new Response(r.body ?? "", { status: r.status, headers: { "content-type": "text/plain" } });
      }
      out.calls.push(url);
      return handler(url, init ?? {});
    }) as typeof fetch,
  };
  return out;
}
