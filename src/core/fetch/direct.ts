// Ported from old_repo/src/lib/sources/charset-decode.mjs (lines 1-69)
// Ported from old_repo/src/lib/sources/pdf-extract.mjs (lines 1-39)
// Ported from old_repo/src/lib/sources/sec-fair-access.ts (lines 1-11)
// Ported from old_repo/src/lib/sources/canonical-fetch.mjs (lines 46-57)
import { toText } from "./classify-body";
import { assertFetchAllowed, type HoldDeps } from "./hold";
import { cleanCtl, fetchDocument, PRIMARY_HEADERS, type FetchDocumentOptions, type FetchRefusal } from "./policy";

export interface FetchDeps extends HoldDeps {
  /** A signed caller name (see AUTHORIZED_HOLD_CALLERS); absent for every scheduled or pipeline path. */
  caller?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** What every transport hands the ladder: a status and the text, plus the truncation facts. A cap never binds silently. */
export interface TransportResult {
  status: number;
  text: string;
  truncated: boolean;
  fullLength: number;
  cap: number;
  finalUrl?: string;
  contentType?: string;
  title?: string | null;
  /** The decoded markup, before text extraction; present only when the caller asked for it (portal-link discovery reads links from it). */
  html?: string;
  refusal?: FetchRefusal | null;
  /** True when this runtime cannot run the transport (the headless tier off the Actions runner). */
  needsHeadless?: boolean;
}

/** The declared User-Agent SEC fair access requires for sec.gov; null for any other host or an unset contact. */
export function secFairAccessUaForUrl(url: string, env: Record<string, string | undefined> = process.env): string | null {
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

/** PDF bytes to text with whitespace collapsed (unpdf's serverless pdf.js). Throws on a non-PDF or an empty text layer: a corrupt PDF is a roadblock, not content. */
export async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; pages: number | null; title: string | null; metaError: string | null }> {
  const { extractText, getDocumentProxy, getMeta } = await import("unpdf");
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const pdf = await getDocumentProxy(owned);
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const full = String(text || "").replace(/\s+/g, " ").trim();
  if (!full) throw new Error("pdf extracted to empty text");
  let title: string | null = null;
  let metaError: string | null = null;
  try {
    const t = ((await getMeta(pdf)).info as Record<string, unknown> | undefined)?.Title;
    if (typeof t === "string" && t.trim()) title = t.trim().slice(0, 500);
  } catch (e) {
    metaError = e instanceof Error ? e.message : String(e);
  }
  return { text: full, pages: totalPages, title, metaError };
}

/**
 * The free direct GET. The hold gate runs first (INV-177): while it is engaged or the cadence is off, nothing reaches the network.
 * HTML is stripped through the one `toText`; PDFs go through unpdf; a charset is read from its declaration; the SEC UA is declared.
 * The ladder, not this function, judges the body (no thin-body or marker refusal here).
 */
export async function fetchDirect(url: string, deps: FetchDeps, opts: { max: number; keepHtml?: boolean } & Pick<FetchDocumentOptions, "timeoutMs">): Promise<TransportResult> {
  await assertFetchAllowed(url, deps.caller, deps);
  const ua = secFairAccessUaForUrl(url, deps.env as Record<string, string | undefined> | undefined);
  const doc = await fetchDocument(url, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now ? { now: () => (deps.now as () => Date)().getTime() } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    headers: ua ? { ...PRIMARY_HEADERS, "User-Agent": ua } : { ...PRIMARY_HEADERS },
    extractPdf: extractPdfText,
    minChars: 0,
    markers: [],
  });
  if (!doc.ok) {
    const text = doc.reason === "error_marker" ? doc.detail : "";
    return { status: doc.status ?? 0, text, truncated: false, fullLength: 0, cap: opts.max, ...(doc.finalUrl ? { finalUrl: doc.finalUrl } : {}), contentType: doc.contentType, refusal: doc };
  }
  const full = (cleanCtl(doc.isPdf ? doc.text : toText(doc.text)) || "").replace(/\s+/g, " ").trim();
  return { status: doc.status, text: full.slice(0, opts.max), truncated: full.length > opts.max, fullLength: full.length, cap: opts.max, finalUrl: doc.finalUrl, contentType: doc.contentType, title: doc.title, ...(opts.keepHtml && !doc.isPdf ? { html: doc.text } : {}), refusal: null };
}
