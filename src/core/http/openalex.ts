// Ported from old_repo/scripts/research/openalex-client.mjs (lines 1-154)
// Ported from old_repo/scripts/research/research-walker.mjs (lines 76-79)
// The free OpenAlex client: polite-pool mailto from the environment (never a literal), 429 backoff, a 20 second timeout per call, 404 as honest absence.
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
export interface OpenAlexDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  email?: string | null;
  baseUrl?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
}

class OpenAlexError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = "OpenAlexError";
    this.status = status;
    this.path = path;
  }
}

const BASE = "https://api.openalex.org";

function buildUrl(path: string, params: Record<string, string | number | null | undefined>, deps: OpenAlexDeps): string {
  const url = new URL(path, deps.baseUrl ?? BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const email = deps.email === undefined ? process.env.OPENALEX_POLITE_EMAIL : deps.email;
  if (email) url.searchParams.set("mailto", email);
  return url.toString();
}

/** GET and parse; 429 retries with backoff (Retry-After honoured), 404 returns null, any other non-2xx throws OpenAlexError. */
export async function openAlexGet<T = Record<string, unknown>>(path: string, params: Record<string, string | number | null | undefined> = {}, deps: OpenAlexDeps = {}): Promise<T | null> {
  const doFetch = deps.fetch ?? (globalThis.fetch as FetchLike);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = deps.maxRetries ?? 3;
  const base = deps.retryBaseMs ?? 500;
  const url = buildUrl(path, params, deps);
  for (let attempt = 0; ; attempt += 1) {
    const res = await doFetch(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000) });
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(res.headers?.get?.("retry-after")) * 1000;
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : base * 2 ** attempt);
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new OpenAlexError(`OpenAlex request failed: ${res.status} ${res.statusText ?? ""} for ${path}`, res.status, path);
    return (await res.json()) as T;
  }
}

/** One work by DOI: a bare DOI, a `doi:` prefix or a doi.org URL all resolve. */
export async function workByDoi(doi: string | null | undefined, deps: OpenAlexDeps = {}): Promise<Record<string, unknown> | null> {
  const normalized = String(doi ?? "").replace(/^https?:\/\/doi\.org\//i, "").replace(/^doi:/i, "").trim();
  return normalized ? openAlexGet(`/works/https://doi.org/${normalized}`, {}, deps) : null;
}

/** A works search (`search` text, optional filter, a page size); the response envelope is returned whole. */
export async function searchWorks(query: { search?: string; filter?: string; perPage?: number }, deps: OpenAlexDeps = {}): Promise<{ results: Record<string, unknown>[] } | null> {
  return openAlexGet("/works", { search: query.search, filter: query.filter, "per-page": query.perPage ?? 25 }, deps);
}
