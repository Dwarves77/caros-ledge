// Ported from old_repo/src/lib/sources/identifier-variants.mjs (lines 1-252)
// Ported from old_repo/src/lib/sources/seek-more.mjs (lines 1-157)
// Ported from old_repo/src/lib/sources/seek-more.mjs (lines 199-247)
// Ported from old_repo/src/lib/sources/primary-fallback.mjs (lines 82-173)

import { log } from "@/core/shared/log";

import { ECFR_PORTAL_URL, FEDERAL_REGISTER_API_BASE, FEDERAL_REGISTER_PORTAL_URL, apiEndpointFor } from "./api";
import { BODY_CLASS, bodyOpts, classifyBody, targetLangRatio } from "./classify-body";

const EUR_LEX_PORTAL_URL = "https://eur-lex.europa.eu";
const LEGISLATION_UK_PORTAL_URL = "https://www.legislation.gov.uk";

/** {year, number} from an identifier in any common separator form (2024_1610, 2024/1610, CELEX or ELI embedded); null when none. */
export function parseYearNumber(s: string | null | undefined): { year: number; number: number } | null {
  const str = String(s || "");
  let m = str.match(/eli\/(?:reg|dir|dec)\/(\d{4})\/(\d+)/i) || str.match(/\b[1-9](\d{4})[A-Z](\d{4})\b/);
  if (m) return { year: Number(m[1]), number: Number((m[2] ?? "").replace(/^0+/, "") || m[2]) };
  m = str.match(/\b(\d{4})[/_\-\s](\d{1,5})\b/);
  return m ? { year: Number(m[1]), number: Number(m[2]) } : null;
}

const toCelex = (year: number, typeLetter: string, number: number): string => `3${year}${typeLetter}${String(number).padStart(4, "0")}`;
/** EU document-type letters to try: a known type gives one letter, an unknown gives all three, each a candidate to fetch and verify. */
function euTypeLetters(itemType: string | null | undefined, instrumentType?: string | null): string[] {
  const t = String(instrumentType || itemType || "").toLowerCase();
  if (/regulation/.test(t)) return ["R"];
  if (/directive/.test(t)) return ["L"];
  if (/decision/.test(t)) return ["D"];
  return ["R", "L", "D"];
}
const ELI_KIND: Record<string, string> = { R: "reg", L: "dir", D: "dec" };

// eur-lex.europa.eu: every URL that host serves is built here, one named builder per distinct endpoint.
export const celexTxtHtmlUrl = (celex: string): string => `${EUR_LEX_PORTAL_URL}/legal-content/EN/TXT/HTML/?uri=CELEX:${celex}`;
const celexTxtUrl = (celex: string): string => `${EUR_LEX_PORTAL_URL}/legal-content/EN/TXT/?uri=CELEX:${celex}`;
const eliPathUrl = (eliPath: string): string => `${EUR_LEX_PORTAL_URL}/eli/${eliPath}`;
const eliUrl = (kind: string, year: number | string, num: number | string): string => eliPathUrl(`${kind}/${year}/${num}/oj/eng`);
const eurlexSearchUrl = (text: string): string => `${EUR_LEX_PORTAL_URL}/search.html?scope=EURLEX&lang=en&text=${encodeURIComponent(text)}`;
export function ojDailyViewUrl(isoDate: string, series = "L"): string {
  const m = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`ojDailyViewUrl: bad ISO date ${isoDate}`);
  return `${EUR_LEX_PORTAL_URL}/oj/daily-view/${series}-series/default.html?ojDate=${m[3]}${m[2]}${m[1]}`;
}
const legislationUkUrl = (path: string): string => `${LEGISLATION_UK_PORTAL_URL}/${path}`;

export interface Identity {
  identifier?: string | null;
  canonicalKey?: string | null;
  itemType?: string | null;
  instrumentType?: string | null;
  title?: string | null;
  jurisdiction?: string[] | string | null;
  sourceUrl?: string | null;
}

/** EU candidates from an identifier or a pre-derived canonical key: CELEX ids, ELI paths, the enacted-text URLs, the search URL. */
export function euCandidates({ identifier, canonicalKey, itemType, instrumentType }: Identity = {}) {
  const celex = new Set<string>();
  const keyM = String(canonicalKey || "").match(/\b([1-9]\d{4}[A-Z]\d{4})\b/);
  if (keyM?.[1]) celex.add(keyM[1]);
  const idKeyM = String(identifier || "").match(/\b([1-9]\d{4}[A-Z]\d{4})\b/);
  if (idKeyM?.[1]) celex.add(idKeyM[1]);
  const yn = parseYearNumber(canonicalKey) || parseYearNumber(identifier);
  if (yn) for (const L of euTypeLetters(itemType, instrumentType)) celex.add(toCelex(yn.year, L, yn.number));
  const urls: string[] = [];
  const eliPaths: string[] = [];
  for (const c of celex) {
    urls.push(celexTxtHtmlUrl(c), celexTxtUrl(c));
    const kind = ELI_KIND[c.charAt(5)];
    if (kind) {
      eliPaths.push(`${kind}/${c.slice(1, 5)}/${Number(c.slice(6))}/oj`);
      urls.push(eliUrl(kind, c.slice(1, 5), Number(c.slice(6))));
    }
  }
  return { celex: [...celex], urls: [...new Set(urls)], eliPaths, searchUrls: [...celex].map(eurlexSearchUrl) };
}
/** An ELI path already inside a source URL or a bare ELI identifier to the eur-lex ELI URL. */
function eliFromIdentity({ identifier, sourceUrl }: Identity = {}): string[] {
  const hay = `${identifier || ""} ${sourceUrl || ""}`;
  const inUrl = hay.match(/\/eli\/((?:reg|dir|dec|regdel|regimpl|dirdel|dirimpl)\/\d{4}\/\d+(?:\/[a-z]+)?)/i);
  if (inUrl?.[1]) return [eliPathUrl(inUrl[1].toLowerCase())];
  const bare = String(identifier || "").match(/^(?:eli\/)?((?:reg|dir|dec|regdel|regimpl|dirdel|dirimpl)\/\d{4}\/\d+)$/i);
  return bare?.[1] ? [eliPathUrl(bare[1].toLowerCase())] : [];
}
/** UK candidates: uksi/ukpga paths (with /made and /contents), the "SI 2023/123" and "2023 No. 123" forms, a bare year/number tried as uksi and ukpga, plus the title search. */
function ukCandidates({ identifier, title }: Identity = {}) {
  const urls: string[] = [];
  const searchUrls: string[] = [];
  const id = String(identifier || "");
  const idm = id.match(/\b(uksi|ukpga|ukssi|ssi|wsi|nisr)\/(\d{4})\/(\d+)/i);
  const si = id.match(/\bS\.?I\.?\s*(\d{4})\/(\d+)/i) || id.match(/^(\d{4})\s*No\.?\s*(\d+)$/i);
  if (idm) {
    const path = `${(idm[1] ?? "").toLowerCase()}/${idm[2]}/${idm[3]}`;
    urls.push(legislationUkUrl(path), legislationUkUrl(`${path}/made`), legislationUkUrl(`${path}/contents`));
  } else if (si) {
    urls.push(legislationUkUrl(`uksi/${si[1]}/${si[2]}`));
  } else {
    const yn = parseYearNumber(identifier);
    if (yn) for (const t of ["uksi", "ukpga"]) urls.push(legislationUkUrl(`${t}/${yn.year}/${yn.number}`));
  }
  if (title) searchUrls.push(`${LEGISLATION_UK_PORTAL_URL}/all?title=${encodeURIComponent(title)}`);
  return { urls: [...new Set(urls)], searchUrls };
}
/** US candidates: the Federal Register by document number, plus the FR API and eCFR searches by title. */
function usCandidates({ identifier, title }: Identity = {}) {
  const urls: string[] = [];
  const searchUrls: string[] = [];
  const doc = String(identifier || "").match(/\b(\d{4}-\d{4,6})\b/);
  if (doc?.[1]) urls.push(`${FEDERAL_REGISTER_PORTAL_URL}/documents/search?conditions%5Bterm%5D=${doc[1]}`, `${FEDERAL_REGISTER_API_BASE}/documents.json?conditions%5Bterm%5D=${doc[1]}`);
  if (title) searchUrls.push(`${FEDERAL_REGISTER_API_BASE}/documents.json?conditions%5Bterm%5D=${encodeURIComponent(title)}`, `${ECFR_PORTAL_URL}/search?search%5Bquery%5D=${encodeURIComponent(title)}`);
  return { urls: [...new Set(urls)], searchUrls };
}
/** Norway: a forskrift citation (FOR-YYYY-MM-DD-N, or the bare form when the jurisdiction is Norway) to the lovdata.no URL. */
function lovdataCandidates({ identifier, jurisdiction }: Identity = {}): string[] {
  const id = String(identifier || "");
  const isNorway = /\bnorway\b|\bnorwegian\b|^no$/i.test(String(jurisdiction || ""));
  let m = id.match(/^FOR[-\s.](\d{4})[-.](\d{2})[-.](\d{2})[-.](\d+)$/i);
  if (!m && isNorway) m = id.match(/^(\d{4})[-.](\d{2})[-.](\d{2})[-.](\d+)$/);
  return m ? [`https://lovdata.no/dokument/SF/forskrift/${m[1]}-${m[2]}-${m[3]}-${m[4]}`] : [];
}
/** National-gazette resolvers by jurisdiction (Ireland's Statute Book first). A wrong pattern fails safely into the exhaustion record. */
const GAZETTE_RESOLVERS: Array<{ test: (j: unknown) => boolean; resolve: (id: unknown) => string[] }> = [
  {
    test: (j) => /\bireland\b|\birish\b|^ie$/i.test(String(j || "")),
    resolve: (id) => {
      const m = String(id || "").match(/(?:S\.?I\.?\s*(?:No\.?)?\s*)?(\d+)\s*of\s*(\d{4})/i) || String(id || "").match(/^(\d+)\/(\d{4})$/);
      return m ? [`https://www.irishstatutebook.ie/eli/${m[2]}/si/${m[1]}/made/en/print`] : [];
    },
  },
];
const gazetteCandidates = ({ identifier, jurisdiction }: Identity = {}): string[] => GAZETTE_RESOLVERS.filter((g) => g.test(jurisdiction)).flatMap((g) => g.resolve(identifier));
/** A source URL on an API-routable host is re-offered, so the ladder's API transport reaches it where the HTML answered "Request Access". */
const apiCandidates = ({ sourceUrl }: Identity = {}): string[] => (sourceUrl && apiEndpointFor(sourceUrl) ? [sourceUrl] : []);

function detectScheme({ identifier, canonicalKey, jurisdiction, sourceUrl }: Identity = {}): "eu" | "uk" | "us" | "generic" {
  const juris = Array.isArray(jurisdiction) ? jurisdiction[0] : jurisdiction;
  let host = "";
  try {
    host = new URL(String(sourceUrl || "")).host.toLowerCase();
  } catch {
    host = "";
  }
  if (juris === "EU" || /eur-lex|europa\.eu/.test(host) || /\b[1-9]\d{4}[A-Z]\d{4}\b|eli\/(?:reg|dir|dec)/i.test(`${identifier} ${canonicalKey}`)) return "eu";
  if (juris === "UK" || juris === "GB" || /legislation\.gov\.uk/.test(host) || /\b(uksi|ukpga)\//i.test(String(identifier))) return "uk";
  if (juris === "US" || /federalregister|ecfr|\.gov$/.test(host)) return "us";
  return "generic";
}

/**
 * The ordered, de-duplicated https candidate list for an instrument identity: identifier-resolved canonical URLs first (EU, UK, Norway, API,
 * gazette, derived variants), then the source's OWN search surface, then the injected open-web search LAST (unbound when no free binding exists).
 */
export async function generateCandidates(identity: Identity = {}, deps: { webSearch?: (query: string) => Promise<string[]> | string[] } = {}): Promise<string[]> {
  const scheme = detectScheme(identity);
  const canonical: string[] = [];
  const search: string[] = [];
  if (scheme === "eu") {
    const eu = euCandidates(identity);
    canonical.push(...eu.urls);
    search.push(...eu.searchUrls);
  } else if (scheme === "uk") {
    const uk = ukCandidates(identity);
    canonical.push(...uk.urls);
    search.push(...uk.searchUrls);
  } else if (scheme === "us") {
    const us = usCandidates(identity);
    canonical.push(...us.urls);
    search.push(...us.searchUrls);
  }
  const ordered = [...eliFromIdentity(identity), ...lovdataCandidates(identity), ...apiCandidates(identity), ...gazetteCandidates(identity), ...canonical, ...search];
  if (deps.webSearch) {
    const q = [identity.title, identity.jurisdiction, "official legislation text"].filter(Boolean).join(" ").trim();
    try {
      for (const u of (await deps.webSearch(q)) || []) ordered.push(u);
    } catch (e) {
      log.warn("[candidates] web search failed; the deterministic candidates stand", e instanceof Error ? e.message : String(e));
    }
  }
  return [...new Set(ordered.filter((u) => typeof u === "string" && /^https:\/\//i.test(u)))];
}

/** Rewrite a known registry URL to the form that returns the ENACTED TEXT (EUR-Lex /TXT soft-404s for many ids; /TXT/HTML/ returns the instrument). */
function renderingUrlForPrimary(url: string): string {
  try {
    const u = new URL(String(url));
    if (u.hostname.replace(/^www\./, "").toLowerCase() === "eur-lex.europa.eu") {
      const rewritten = u.pathname.replace(/\/legal-content\/([a-z]{2})\/txt\/?$/i, "/legal-content/$1/TXT/HTML/");
      if (rewritten !== u.pathname) {
        u.pathname = rewritten;
        return u.toString();
      }
    }
    return url;
  } catch {
    return url;
  }
}

/** A roadblock is a body that is not usable English-language primary content; a bias towards "primary succeeded" keeps a false roadblock from downgrading a thin real primary. */
function detectRoadblock(text: string | null | undefined, url: string, opts: { status?: number; timedOut?: boolean } = {}): { roadblocked: boolean; reason: string; len: number; langRatio: number } {
  const s = String(text || "");
  const v = classifyBody(s, bodyOpts(url, { status: opts.status ?? 200, timedOut: opts.timedOut ?? false }));
  return { roadblocked: v.class !== BODY_CLASS.OK, reason: v.class, len: s.trim().length, langRatio: targetLangRatio(s) };
}

export interface FallbackAlternative {
  url: string;
  len: number;
  langRatio: number;
  reason: string;
  role: "declared_primary" | "alternative";
}
export interface FallbackResult {
  ok: boolean;
  url: string;
  text: string;
  roadblocked: boolean;
  primaryReason: string;
  fellBack: boolean;
  alternatives: FallbackAlternative[];
  /** Set when the discovery of alternative candidates itself failed: a failed discovery is a stated failure beside the result, never "no candidates found". */
  discoveryError?: string;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/** One bounded fetch: the injected fetcher raced against a deadline, with the timer cleared (a roadblock is persistent, so it is never retried). */
async function boundedFetch(fetchText: (url: string) => Promise<{ text?: string; status?: number }>, url: string, ms: number): Promise<{ text: string; status: number; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([fetchText(url), new Promise<"timeout">((res) => (timer = setTimeout(() => res("timeout"), ms)))]);
    if (r === "timeout") return { text: "", status: 200, timedOut: true };
    return { text: r?.text || "", status: r?.status ?? 200, timedOut: false };
  } catch (e) {
    return { text: "", status: (e as { status?: number } | null)?.status ?? 0, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try the declared primary; on a genuine roadblock, try the discovered candidates (a bounded set), recording every attempt. This widens only the
 * set of URLs tried: it decides no tier and no qualification, the caller's resolver and per-type floor still do (INV-178).
 */
export async function fetchPrimaryWithFallback(
  { primaryUrl }: { primaryUrl: string },
  deps: { fetchText: (url: string) => Promise<{ text?: string; status?: number }>; discoverCandidates?: () => Promise<string[]> | string[]; perFetchMs?: number; maxCandidates?: number },
): Promise<FallbackResult> {
  const { fetchText, discoverCandidates, perFetchMs = 20_000, maxCandidates = 6 } = deps;
  const primary = renderingUrlForPrimary(primaryUrl);
  const alternatives: FallbackAlternative[] = [];
  const p = await boundedFetch(fetchText, primary, perFetchMs);
  const pd = detectRoadblock(p.text, primary, { status: p.status, timedOut: p.timedOut });
  alternatives.push({ url: primary, len: pd.len, langRatio: round2(pd.langRatio), reason: pd.reason, role: "declared_primary" });
  if (!pd.roadblocked) return { ok: true, url: primary, text: p.text, roadblocked: false, primaryReason: pd.reason, fellBack: false, alternatives };
  let discovered: string[] = [];
  let discoveryError: string | undefined;
  try {
    discovered = (await discoverCandidates?.()) || [];
  } catch (e) {
    discoveryError = e instanceof Error ? e.message : String(e);
  }
  const failure = discoveryError ? { discoveryError } : {};
  for (const u of [...new Set(discovered.filter((x) => typeof x === "string" && /^https?:\/\//i.test(x) && x !== primary))].slice(0, maxCandidates)) {
    const r = await boundedFetch(fetchText, u, perFetchMs);
    const d = detectRoadblock(r.text, u, { status: r.status, timedOut: r.timedOut });
    alternatives.push({ url: u, len: d.len, langRatio: round2(d.langRatio), reason: d.reason, role: "alternative" });
    if (!d.roadblocked) return { ok: true, url: u, text: r.text, roadblocked: true, primaryReason: pd.reason, fellBack: true, alternatives, ...failure };
  }
  return { ok: false, url: primary, text: "", roadblocked: true, primaryReason: pd.reason, fellBack: true, alternatives, ...failure };
}

export interface PoolCapture {
  url: string;
  text: string;
}
export interface HeldPoolHit {
  item_id: string;
  relation: "self" | "connected";
  pool: PoolCapture[];
  item_pool_hash: string;
}
/** The pool identity hash of a set of hits, over every capture with its url prefixed by its item id; the hash function is the grounding slice's `hashSourcePool`, injected. */
export function heldPoolHash(hits: Array<{ item_id: string; pool: PoolCapture[] }>, hashSourcePool: (rows: PoolCapture[]) => string): string {
  return hashSourcePool(hits.flatMap((h) => h.pool.map((c) => ({ url: `${h.item_id}#${c.url}`, text: c.text }))));
}
/** The held pool text a question can be answered from: its own item first, then connected items in the caller's order; only an item with a usable capture is a hit. Free: no model, no search, no network. */
export async function queryHeldPools(
  question: { itemId: string },
  deps: { readConnectedItemIds?: (itemId: string) => Promise<string[]> | string[]; readPools: (itemIds: string[]) => Promise<Map<string, PoolCapture[]>> | Map<string, PoolCapture[]>; hashSourcePool: (rows: PoolCapture[]) => string },
): Promise<HeldPoolHit[]> {
  const itemId = question?.itemId;
  if (!itemId) return [];
  const connected = (await deps.readConnectedItemIds?.(itemId)) ?? [];
  const ids = [...new Set([itemId, ...connected.filter((id) => typeof id === "string" && id)])];
  const got = await deps.readPools(ids);
  const hits: HeldPoolHit[] = [];
  for (const id of ids) {
    const pool = (got.get(id) ?? []).filter((c) => typeof c?.url === "string" && typeof c?.text === "string" && c.text.trim() !== "");
    if (pool.length) hits.push({ item_id: id, relation: id === itemId ? "self" : "connected", pool, item_pool_hash: deps.hashSourcePool(pool) });
  }
  return hits;
}
