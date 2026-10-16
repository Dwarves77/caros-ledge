// Ported from old_repo/src/lib/sources/register-walk.mjs (lines 1-172)
import { FEDERAL_REGISTER_API_BASE } from "@/core/fetch/api";
import { ojDailyViewUrl } from "@/core/fetch/candidates";

import type { Persist } from "./feed";
import { extractPortalLinks } from "./portal-links";

export { ojDailyViewUrl };

/** The Federal Register documents.json index URL (public API, no key). */
export function frDocumentsUrl({ from, to, page = 1, perPage = 100, types = ["RULE"], term }: { from: string; to: string; page?: number; perPage?: number; types?: string[]; term?: string }): string {
  for (const d of [from, to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) throw new Error(`frDocumentsUrl: bad ISO date ${d}`);
  const q = new URLSearchParams();
  q.set("conditions[publication_date][gte]", from);
  q.set("conditions[publication_date][lte]", to);
  for (const t of types) q.append("conditions[type][]", t);
  if (term) q.set("conditions[term]", term);
  q.set("per_page", String(Math.min(perPage, 1000)));
  q.set("page", String(page));
  q.set("order", "oldest");
  for (const f of ["html_url", "title", "type", "publication_date", "document_number"]) q.append("fields[]", f);
  return `${FEDERAL_REGISTER_API_BASE}/documents.json?${q.toString()}`;
}
/** FR API results to the ledger's link shape (html_url plus title as the anchor hint); a row without an https html_url is dropped. */
export function frDocsToLinks(json: { results?: Array<{ html_url?: string; title?: string; type?: string; publication_date?: string }> } | null | undefined): Array<{ url: string; anchorText: string | null }> {
  const out: Array<{ url: string; anchorText: string | null }> = [];
  for (const r of json?.results ?? []) {
    if (typeof r.html_url !== "string" || !/^https:\/\//i.test(r.html_url)) continue;
    const bits = [r.title, r.type && r.publication_date ? `${r.type} ${r.publication_date}` : null].filter(Boolean);
    out.push({ url: r.html_url, anchorText: bits.length ? bits.join(" — ").slice(0, 300) : null });
  }
  return out;
}
/** An inclusive UTC calendar-day range. A reversed range throws, and over 366 days is refused: a register walk is a bounded run, not a backfill. */
export function dateRange(fromIso: string, toIso: string): string[] {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  if (Number.isNaN(+from) || Number.isNaN(+to)) throw new Error(`dateRange: bad dates ${fromIso}..${toIso}`);
  if (from > to) throw new Error(`dateRange: from ${fromIso} after to ${toIso}`);
  const days = Math.round((+to - +from) / 86_400_000) + 1;
  if (days > 366) throw new Error(`dateRange: ${days} days: refuse unbounded walks (cap 366)`);
  const out: string[] = [];
  for (let t = +from; t <= +to; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// An OJ daily view lists its acts as /legal-content/<LANG>/TXT/?uri=OJ:... or /eli/... links; the rest of the page is chrome that would also satisfy the generic extractor.
const OJ_ACT_LINK_RE = /\/(legal-content|eli)\//i;
/** Does this HTML look like an EUR-Lex OJ daily view at all? A zero-link page that fails this is an ERROR day (a rate-limit or interstitial page), never an honest empty week. */
export const looksLikeOjDailyView = (html: unknown): boolean => String(html ?? "").includes("daily-view") && /official\s+journal/i.test(String(html ?? ""));

/**
 * Walk the EUR-Lex OJ daily views for a date range: per day, fetch (injected), extract act links, persist (injected). A fetch failure on one day is recorded and the walk continues.
 * EUR-Lex serves the LAST published edition for a date with none, so a day whose act set is identical to an earlier day's is `duplicate_of` that day and not persisted again.
 * Uncapped by default: a free enumeration is never capped.
 */
export async function walkEurlexOj(deps: { fetchHtml: (url: string) => Promise<string>; persist: Persist }, { from, to, series = "L", cap = Infinity }: { from: string; to: string; series?: string; cap?: number }) {
  const days: Array<Record<string, unknown>> = [];
  let upserted = 0;
  let failed = 0;
  const seenEditions = new Map<string, string>();
  for (const day of dateRange(from, to)) {
    const url = ojDailyViewUrl(day, series);
    try {
      const html = await deps.fetchHtml(url);
      const bytes = String(html ?? "").length;
      const links = extractPortalLinks(html, url, { cap }).filter((l) => OJ_ACT_LINK_RE.test(new URL(l.url).pathname));
      if (links.length === 0 && !looksLikeOjDailyView(html)) throw new Error(`unexpected page shape: ${bytes} bytes with no daily-view markers (not the OJ register); head: ${JSON.stringify(String(html ?? "").replace(/\s+/g, " ").slice(0, 200))}`);
      const urls = links.map((l) => l.url);
      const signature = [...urls].sort().join("\n");
      const duplicateOf = links.length > 0 ? (seenEditions.get(signature) ?? null) : null;
      if (duplicateOf) {
        days.push({ day, url, extracted: 0, upserted: 0, bytes, urls: [], duplicate_of: duplicateOf, error: null });
        continue;
      }
      if (links.length > 0) seenEditions.set(signature, day);
      const p = await deps.persist(links);
      upserted += p.upserted;
      failed += p.failed;
      days.push({ day, url, extracted: links.length, upserted: p.upserted, bytes, urls, duplicate_of: null, error: null });
    } catch (e) {
      days.push({ day, url, extracted: 0, upserted: 0, bytes: null, urls: [], duplicate_of: null, error: (e as Error).message });
    }
  }
  return { register: "eurlex-oj", series, from, to, days, upserted, failed };
}

/** Walk the Federal Register documents index for a date range: paged JSON (injected), links, persist. Bounded by maxPages, and a bound that bites is reported (droppedPages), never silent. */
export async function walkFederalRegister(deps: { fetchJson: (url: string) => Promise<{ count?: number; total_pages?: number; next_page_url?: string | null; results?: never[] } | null>; persist: Persist }, { from, to, types = ["RULE"], term, perPage = 100, maxPages = 5 }: { from: string; to: string; types?: string[]; term?: string; perPage?: number; maxPages?: number }) {
  dateRange(from, to);
  const pages: Array<{ page: number; url: string; results: number; upserted: number }> = [];
  let upserted = 0;
  let failed = 0;
  let totalCount: number | null = null;
  let totalPages: number | null = null;
  for (let page = 1; page <= maxPages; page++) {
    const url = frDocumentsUrl({ from, to, page, perPage, types, ...(term ? { term } : {}) });
    const json = await deps.fetchJson(url);
    totalCount = typeof json?.count === "number" ? json.count : totalCount;
    totalPages = typeof json?.total_pages === "number" ? json.total_pages : totalPages;
    const links = frDocsToLinks(json);
    const p = await deps.persist(links);
    upserted += p.upserted;
    failed += p.failed;
    pages.push({ page, url, results: links.length, upserted: p.upserted });
    if (!json?.next_page_url || (totalPages != null && page >= totalPages)) break;
  }
  const droppedPages = totalPages != null && totalPages > pages.length ? totalPages - pages.length : 0;
  return { register: "federal-register", from, to, types, term: term ?? null, pages, upserted, failed, totalCount, totalPages, droppedPages };
}
