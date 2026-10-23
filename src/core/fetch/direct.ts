// Ported from old_repo/src/lib/sources/charset-decode.mjs (lines 1-69)
// Ported from old_repo/src/lib/sources/pdf-extract.mjs (lines 1-39)
// Ported from old_repo/src/lib/sources/canonical-fetch.mjs (lines 46-57)
import { toText } from "./classify-body";
import { assertFetchAllowed, type HoldDeps } from "./hold";
import { honestFetch } from "./honest";
import { cleanCtl, extractPdfBudgeted, fetchDocument, type FetchDocumentOptions, type FetchRefusal, type PdfLib } from "./policy";

export interface FetchDeps extends HoldDeps {
  /** A signed caller name (see AUTHORIZED_HOLD_CALLERS); absent for every scheduled or pipeline path. */
  caller?: string | null;
  /** The raw network fetch under the guard (tests inject a fake); every transport wraps it with honestFetch, so the identity, the address check and robots.txt apply whatever is injected. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  resolveHost: ((host: string) => Promise<string[]>) | null;
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
  /** The language the document declares (BCP-47), null when it declares none. */
  language?: string | null;
  /** The decoded markup, before text extraction; present only when the caller asked for it (portal-link discovery reads links from it). */
  html?: string;
  refusal?: FetchRefusal | null;
  /** True when this runtime cannot run the transport (the browser tier off the Actions runner). */
  needsHeadless?: boolean;
  /** The channel that produced the text (R2c): set by the browser tier; the ladder names the others. */
  channel?: "api" | "feed" | "sitemap" | "direct" | "browser" | "substitute";
}

/** PDF bytes to text with whitespace collapsed (unpdf's serverless pdf.js), under the page and time budget (extractPdfBudgeted). Throws on a non-PDF, an empty text layer or an over-budget document: a corrupt PDF is a roadblock, not content. `lib` is the reader (unpdf by default). */
export async function extractPdfText(bytes: Uint8Array, lib?: PdfLib<{ numPages: number; destroy?: () => unknown }>, opts: { timeoutMs?: number } = {}): Promise<{ text: string; pages: number | null; title: string | null; metaError: string | null }> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const out = await extractPdfBudgeted(owned, lib ?? ((await import("unpdf")) as unknown as PdfLib<{ numPages: number; destroy?: () => unknown }>), opts);
  const full = out.text.replace(/\s+/g, " ").trim();
  if (!full) throw new Error("pdf extracted to empty text");
  return { ...out, text: full };
}

/**
 * The free direct GET under the declared identity. The hold gate runs first (INV-177): while it is engaged or the cadence is off, nothing reaches the network.
 * HTML is stripped through the one `toText`; PDFs go through unpdf; a charset is read from its declaration; the SEC UA is declared. A 403, 429 or robots refusal is final here: the ladder tries the next channel.
 * The ladder, not this function, judges the body (no thin-body or marker refusal here).
 */
export async function fetchDirect(url: string, deps: FetchDeps, opts: { max: number; keepHtml?: boolean } & Pick<FetchDocumentOptions, "timeoutMs">): Promise<TransportResult> {
  await assertFetchAllowed(url, deps.caller, deps);
  const doc = await fetchDocument(url, {
    fetchImpl: honestFetch(deps),
    ...(deps.now ? { now: () => (deps.now as () => Date)().getTime() } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    extractPdf: extractPdfText,
    minChars: 0,
    markers: [],
  });
  if (!doc.ok) {
    const text = doc.reason === "error_marker" ? doc.detail : "";
    return { status: doc.status ?? 0, text, truncated: false, fullLength: 0, cap: opts.max, ...(doc.finalUrl ? { finalUrl: doc.finalUrl } : {}), contentType: doc.contentType, refusal: doc };
  }
  const full = (cleanCtl(doc.isPdf ? doc.text : toText(doc.text)) || "").replace(/\s+/g, " ").trim();
  return { status: doc.status, text: full.slice(0, opts.max), truncated: full.length > opts.max, fullLength: full.length, cap: opts.max, finalUrl: doc.finalUrl, contentType: doc.contentType, title: doc.title, language: doc.language, ...(opts.keepHtml && !doc.isPdf ? { html: doc.text } : {}), refusal: null };
}
