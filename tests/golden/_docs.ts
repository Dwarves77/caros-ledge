import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The honest identity every golden-corpus fetch declares (R6a): one request per second per host, a shared on-disk cache so a test run does not refetch. */
export const GOLDEN_UA = "CarosLedge/1.0 (+https://carosledge.com/bot)";
const CACHE = join(tmpdir(), "caros-golden-cache");
const TTL_MS = 6 * 3600 * 1000;
const lastByHost = new Map<string, number>();

export type FetchedDoc = { ok: true; pages: string[]; bytes: number } | { ok: false; reason: string };
const memo = new Map<string, Promise<FetchedDoc>>();

async function pace(host: string): Promise<void> {
  const wait = (lastByHost.get(host) ?? 0) + 1100 - Date.now();
  lastByHost.set(host, Math.max(Date.now(), (lastByHost.get(host) ?? 0) + 1100));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** HTML to readable text: scripts and styles dropped, block ends become newlines, entities for the characters the pages use decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|table|ul|ol|section|article)>|<br\s*\/?>/gi, "\n").replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&#8217;/g, "’").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function fetchOnce(url: string, format: "pdf" | "html"): Promise<FetchedDoc> {
  const file = join(CACHE, createHash("sha1").update(url).digest("hex"));
  let bytes: Uint8Array;
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < TTL_MS) bytes = readFileSync(file);
  else {
    await pace(new URL(url).host);
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": GOLDEN_UA }, redirect: "follow", signal: AbortSignal.timeout(90_000) });
    } catch (e) {
      return { ok: false, reason: `network: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) return { ok: false, reason: "empty body" };
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(file, bytes);
  }
  if (format === "html") return { ok: true, pages: [htmlToText(new TextDecoder().decode(bytes))], bytes: bytes.length };
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return { ok: false, reason: "not a PDF (served a page instead of the document)" };
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return { ok: true, pages: (text as string[]).map((t) => t.replace(/\s+/g, " ")), bytes: bytes.length };
}

/** The pages of a document as text (a PDF per page, a web page as one). A failed fetch is a stated reason, never an empty page. */
export function getDoc(url: string, format: "pdf" | "html"): Promise<FetchedDoc> {
  let p = memo.get(url);
  if (!p) memo.set(url, (p = fetchOnce(url, format)));
  return p;
}

const norm = (s: string) => s.replace(/[   ]/g, " ").replace(/\s+/g, " ");
/** True when `token` is on the text as a whole token: a numeral never matches inside a longer digit run (the same boundary rule R2a's comparator applies). */
export function hasToken(text: string, token: string): boolean {
  const t = norm(token).trim();
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pre = /^\d/.test(t) ? "(?<!\\d[.,])(?<!\\d)" : "";
  const post = /\d$/.test(t) ? "(?!\\d)(?![.,]\\d)" : "";
  return new RegExp(`${pre}${esc}${post}`).test(norm(text));
}
