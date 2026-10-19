// Ported from old_repo/supabase/functions/capture-worker/index.ts (lines 71-220)
// Ported from old_repo/src/lib/sources/charset-decode.mjs (lines 1-69)
// The one fetch policy. Web-standard APIs only and no imports, so the Edge Function (Deno) and the Node transports both import it by relative path.
// R2c: one declared identity (the second browser fingerprint and the retry as another identity are deleted), guard refusals typed, bounded sizes.

export const ERROR_MARKERS = ["Attention Required! | Cloudflare", "Just a moment...", "cf-error-details", "Request unsuccessful. Incapsula", "Access Denied</title>", "error-page-container"];
export const MIN_BYTES = 1000;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_BYTES = 50 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 45_000;
/** Transient statuses requeue: 202 (EUR-Lex warm-up), 408, 425, 429, 5xx. A network throw is transient too. */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([202, 408, 425, 429, 500, 502, 503, 504]);
export const MAX_ATTEMPTS = 5;
/** ADR-016: a pathological-page sanity ceiling, never an operating cap; binding it is loud. */
export const DEFAULT_STORAGE_MAX_CHARS = 10_000_000;

/** The one declared identity of every transport that is not a person's browser (R2c C1; docs: the /bot page). The SEC fair-access string for sec.gov is a declared identity of the same kind. */
export const BOT_USER_AGENT = "CarosLedge/1.0 (+https://carosledge.com/bot)";
export const DECLARED_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": BOT_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
/** A refusal by the host's wall: the identity was declined (403, 429) or needs credentials (401). It is final for that transport; the next channel is tried, never another identity. */
export const isWallStatus = (status: number | null | undefined): boolean => status === 401 || status === 403 || status === 429;
/** Request bodies and inflated payloads are bounded (R2c C9): a route body, a gunzipped sitemap, a feed. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const MAX_INFLATED_BYTES = 100 * 1024 * 1024;

/** Content-type allowlist for the non-PDF path; a type that is neither text-like nor PDF is a clean unsupported failure. */
export function isTextType(ct: string): boolean {
  if (!ct) return true;
  return ct.startsWith("text/") || ct.includes("html") || ct.includes("xml") || ct.includes("json") || ct.includes("+text");
}

const CHARSET_ALIASES = new Map([
  ["utf-8", "utf-8"], ["utf8", "utf-8"], ["us-ascii", "utf-8"], ["ascii", "utf-8"],
  ["iso-8859-1", "windows-1252"], ["iso8859-1", "windows-1252"], ["latin1", "windows-1252"], ["latin-1", "windows-1252"], ["l1", "windows-1252"], ["cp1252", "windows-1252"], ["windows-1252", "windows-1252"],
  ["iso-8859-15", "iso-8859-15"], ["latin9", "iso-8859-15"], ["utf-16", "utf-16le"], ["utf-16le", "utf-16le"], ["utf-16be", "utf-16be"],
]);
function normalizeCharsetLabel(raw: string | null | undefined): string | null {
  const key = String(raw ?? "").trim().toLowerCase().replace(/^["']|["']$/g, "");
  if (!key) return null;
  const alias = CHARSET_ALIASES.get(key);
  if (alias) return alias;
  try {
    new TextDecoder(key);
    return key;
  } catch {
    return null;
  }
}
/** The charset the bytes DECLARE: the header first, then a <meta> in the first 4 KB, else null (the caller defaults to UTF-8). */
export function declaredCharset(bytes: Uint8Array, contentType: string | null | undefined): { charset: string; source: "header" | "meta" } | null {
  const h = /charset\s*=\s*([^;]+)/i.exec(String(contentType ?? ""));
  const fromHeader = normalizeCharsetLabel(h?.[1]);
  if (fromHeader) return { charset: fromHeader, source: "header" };
  const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, 4096));
  const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i) ?? head.match(/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_-]+)/i);
  const fromMeta = normalizeCharsetLabel(m?.[1]);
  return fromMeta ? { charset: fromMeta, source: "meta" } : null;
}
/** Decode bytes by their declared charset (header, then meta), else UTF-8. */
export function decodeBody(bytes: Uint8Array, contentType: string | null | undefined): { text: string; charset: string; source: "header" | "meta" | "default" } {
  const d = declaredCharset(bytes, contentType);
  try {
    return { text: new TextDecoder(d?.charset ?? "utf-8", { fatal: false }).decode(bytes), charset: d?.charset ?? "utf-8", source: d?.source ?? "default" };
  } catch {
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), charset: "utf-8", source: "default" };
  }
}
/** Replace C0 control characters (except tab, LF, CR) with a space. */
export const cleanCtl = (s: string): string => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ");

/** A language tag as a capture records it (BCP-47: language lower case, script title case, region upper case), or null when the text is not one. Never a guess. */
export function normalizeLocale(raw: string | null | undefined): string | null {
  const m = /^([A-Za-z]{2,3})(?:[-_]([A-Za-z]{4}))?(?:[-_]([A-Za-z]{2}|[0-9]{3}))?$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const script = m[2] ? `${m[2].charAt(0).toUpperCase()}${m[2].slice(1).toLowerCase()}` : null;
  return [(m[1] as string).toLowerCase(), script, m[3]?.toUpperCase()].filter(Boolean).join("-");
}
/** The language a fetched document declares: the `lang` attribute of its root element, else the first tag of the Content-Language header; null when neither is a language tag. */
export function documentLanguage(contentLanguage: string | null | undefined, markup: string | null | undefined): string | null {
  const fromMarkup = /<html\b[^>]*?\slang\s*=\s*["']?([A-Za-z0-9_-]+)/i.exec((markup ?? "").slice(0, 4096))?.[1];
  return normalizeLocale(fromMarkup) ?? normalizeLocale(String(contentLanguage ?? "").split(",")[0]);
}
/** The locale a capture records: the publisher's declared locale from the registry, else what the document declares, else null. */
export const captureLocale = (publisherLocale: string | null | undefined, documentDeclared: string | null | undefined): string | null => normalizeLocale(publisherLocale) ?? normalizeLocale(documentDeclared);

export const isPdfBytes = (b: Uint8Array): boolean => b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;
/** A body is a PDF when the content type says so or the magic bytes do. */
export const isPdfDocument = (contentType: string | null | undefined, bytes: Uint8Array): boolean => /application\/(x-)?pdf/i.test(String(contentType ?? "")) || isPdfBytes(bytes);

/** Thrown when the cap is crossed while streaming; carries the bytes actually read. */
export class BodyTooLargeError extends Error {
  readonly bytesRead: number;
  constructor(bytesRead: number) {
    super(`body exceeded ${bytesRead} bytes read`);
    this.name = "BodyTooLargeError";
    this.bytesRead = bytesRead;
  }
}

/** Read a body as a stream and abort the instant the running total crosses `capBytes`: a pathological download is refused mid-stream, never fully buffered. */
export async function readBodyCapped(resp: Response, capBytes: number): Promise<Uint8Array> {
  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > capBytes) throw new BodyTooLargeError(declared);
  const reader = resp.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > capBytes) throw new BodyTooLargeError(buf.byteLength);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > capBytes) {
      let cancelError: unknown;
      try {
        await reader.cancel();
      } catch (e) {
        cancelError = e;
      }
      throw Object.assign(new BodyTooLargeError(total), cancelError === undefined ? {} : { cause: cancelError });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export type RefusalReason = "non_200" | "unsupported_type" | "too_large" | "too_small" | "error_marker" | "pdf_failed" | "pdf_unavailable" | "network" | "robots_disallowed" | "robots_unknown" | "private_address" | "bad_scheme" | "too_many_redirects" | "host_busy" | "paywalled" | "raw_text_unavailable" | "interactive_challenge" | "gated" | "browser_launch_failed";
export interface FetchRefusal {
  ok: false;
  reason: RefusalReason;
  /** A transient refusal is requeued (up to MAX_ATTEMPTS); a permanent one is a recorded failure. */
  transient: boolean;
  status: number | null;
  contentType: string;
  finalUrl: string | null;
  pdfBytes: number | null;
  detail: string;
  /** The robots.txt rule that disallowed the URL, for robots_disallowed. */
  rule?: string;
  /** For robots_unknown: robots.txt itself refused the declared identity (401, 403, 429); the browser tier may re-read it. */
  identityRefused?: boolean;
}
export interface FetchedDocument {
  ok: true;
  status: number;
  finalUrl: string;
  contentType: string;
  /** The full decoded text. Never shortened except at the sanity ceiling, which is reported in `ceilingBind`. */
  text: string;
  /** Length of the text before the ceiling was applied. */
  fullLength: number;
  title: string | null;
  isPdf: boolean;
  pdfPages: number | null;
  pdfBytes: number | null;
  /** The language the document declares (its lang attribute, else Content-Language), BCP-47; null when it declares none. */
  language: string | null;
  nullsRemoved: number;
  ceilingBind: { collected: number; fullLength: number } | null;
  /** Every transform applied to the bytes, declared. */
  declaredTransforms: Array<Record<string, unknown>>;
}
export type FetchOutcome = FetchedDocument | FetchRefusal;

export interface FetchDocumentOptions {
  /** The guarded GET (guard.ts): the declared identity, the address check on every hop, robots.txt and the per-host gap. There is no unguarded default. */
  fetchImpl: typeof fetch;
  /** PDF bytes to text; each runtime supplies its own (unpdf). Absent means a PDF is a typed refusal. */
  extractPdf?: (bytes: Uint8Array) => Promise<{ text: string; pages: number | null; title: string | null; metaError?: string | null }>;
  now?: () => number;
  timeoutMs?: number;
  /** Request headers beyond the declared ones (an Accept and Accept-Language a publisher resolver needs); the User-Agent is always the declared one, the guard sets it. */
  headers?: Record<string, string>;
  minChars?: number;
  maxChars?: number;
  /** The change-detection pass reads reachability from a non-200, so it asks for the refusal rather than a throw. */
  markers?: readonly string[];
}

const refusal = (reason: RefusalReason, transient: boolean, status: number | null, contentType: string, finalUrl: string | null, detail: string, pdfBytes: number | null = null): FetchRefusal => ({ ok: false, reason, transient, status, contentType, finalUrl, pdfBytes, detail });

/** The ADR-016 ceiling reader: STORAGE_MAX_CHARS from the environment with the shared default. */
export function storageMaxChars(env: Record<string, string | undefined>): number {
  const n = Number(env.STORAGE_MAX_CHARS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STORAGE_MAX_CHARS;
}

/**
 * One document fetch under the shared policy: the declared identity through the guarded GET, a hard deadline, a streamed capped read, a charset-aware decode, U+0000 removal (counted), and refusal of a non-200,
 * an unsupported type, an error page or a thin body. A 403 or 429 is final for this transport: there is no retry as another identity. Never throws: a failure is a typed refusal.
 */
export async function fetchDocument(url: string, opts: FetchDocumentOptions): Promise<FetchOutcome> {
  const doFetch = opts.fetchImpl;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  let finalUrl: string | null = null;
  let contentType = "";
  try {
    const resp = await doFetch(url, { redirect: "follow", headers: { ...DECLARED_HEADERS, ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
    finalUrl = resp.url || url;
    contentType = (resp.headers.get("content-type") || "").toLowerCase();
    if (resp.status !== 200) return refusal("non_200", RETRYABLE_STATUS.has(resp.status), resp.status, contentType, finalUrl, `non-200 status ${resp.status}, body NOT stored`);
    const maybePdf = contentType.startsWith("application/pdf");
    if (!maybePdf && !isTextType(contentType)) return refusal("unsupported_type", false, 200, contentType, finalUrl, `unsupported content-type (${contentType}): not text or PDF, NOT stored`);

    let bytes: Uint8Array;
    try {
      bytes = await readBodyCapped(resp, maybePdf ? MAX_PDF_BYTES : MAX_TEXT_BYTES);
    } catch (e) {
      if (e instanceof BodyTooLargeError) return refusal("too_large", false, 200, contentType, finalUrl, `body too large (${e.bytesRead} bytes read past the ${maybePdf ? MAX_PDF_BYTES : MAX_TEXT_BYTES} cap), NOT stored`, maybePdf ? e.bytesRead : null);
      throw e;
    }
    const isPdf = maybePdf || isPdfBytes(bytes);
    let text: string;
    let title: string | null = null;
    let pdfPages: number | null = null;
    let pdfMetaError: string | null = null;
    if (isPdf) {
      if (!opts.extractPdf) return refusal("pdf_unavailable", false, 200, contentType, finalUrl, "pdf text extraction is not available in this runtime, NOT stored", bytes.byteLength);
      try {
        const out = await opts.extractPdf(bytes);
        text = out.text;
        pdfPages = out.pages;
        title = out.title;
        pdfMetaError = out.metaError ?? null;
      } catch (e) {
        return refusal("pdf_failed", false, 200, contentType, finalUrl, `pdf extraction failed: ${(e as Error).message}, NOT stored`, bytes.byteLength);
      }
    } else {
      text = decodeBody(bytes, contentType).text;
    }
    const declaredTransforms: Array<Record<string, unknown>> = [];
    const at = new Date((opts.now ?? Date.now)()).toISOString();
    const beforeLen = text.length;
    let nullsRemoved = 0;
    if (text.includes("\u0000")) {
      text = text.replaceAll("\u0000", "");
      nullsRemoved = beforeLen - text.length;
      declaredTransforms.push({ declared_transform: "u0000-removal", count: nullsRemoved, at });
    }
    if (text.length < (opts.minChars ?? MIN_BYTES)) {
      return refusal("too_small", false, 200, contentType, finalUrl, isPdf ? `pdf text layer too small (${text.length} chars over ${pdfPages ?? "?"} pages), likely a scanned PDF, NOT stored` : `body too small (${text.length} chars), NOT stored`, isPdf ? bytes.byteLength : null);
    }
    const marker = (opts.markers ?? ERROR_MARKERS).find((m) => text.includes(m));
    if (marker) return refusal("error_marker", false, 200, contentType, finalUrl, `error-page marker "${marker}", NOT stored`);
    if (isPdf) declaredTransforms.push({ declared_transform: "pdf-text-extraction", engine: "unpdf(pdf.js)", pages: pdfPages, pdf_bytes: bytes.byteLength, extracted_chars: text.length, ...(pdfMetaError ? { metadata_error: pdfMetaError } : {}), at });
    const fullLength = text.length;
    let ceilingBind: FetchedDocument["ceilingBind"] = null;
    const cap = opts.maxChars;
    if (cap !== undefined && text.length > cap) {
      ceilingBind = { collected: cap, fullLength };
      text = text.slice(0, cap);
      declaredTransforms.push({ declared_transform: "storage-ceiling-bind", cap, collected: cap, full_length: fullLength, at });
    }
    if (!isPdf) title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.trim().slice(0, 500) ?? null;
    const language = documentLanguage(resp.headers.get("content-language"), isPdf ? null : text);
    return { ok: true, status: 200, finalUrl, contentType, text, fullLength, title, isPdf, pdfPages, pdfBytes: isPdf ? bytes.byteLength : null, language, nullsRemoved, ceilingBind, declaredTransforms };
  } catch (e) {
    const g = (e as { fetchRefusal?: { reason: RefusalReason; transient: boolean; detail: string; rule?: string; identityRefused?: boolean } } | null)?.fetchRefusal;
    if (g) return { ...refusal(g.reason, g.transient, null, contentType, finalUrl, g.detail), ...(g.rule ? { rule: g.rule } : {}), ...(g.identityRefused ? { identityRefused: true } : {}) };
    return refusal("network", true, null, contentType, finalUrl, `fetch error: ${(e as Error).message}`);
  }
}
