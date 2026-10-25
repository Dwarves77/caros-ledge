import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { licenceForbidsHost } from "@/core/fetch/licence-hosts";
import { runProducer, type ProducerSpec } from "@/core/producers/runner";

/** The honest identity every golden-corpus fetch declares (R6a): one request per second per host, a shared on-disk cache so a test run does not refetch. */
const GOLDEN_UA = "CarosLedge/1.0 (+https://carosledge.com/bot)";
const CACHE = join(tmpdir(), "caros-golden-cache");
const TTL_MS = 6 * 3600 * 1000;
const lastByHost = new Map<string, number>();
// The producers' one fetch policy (runner.ts makeGetter, reached through a dry runProducer): a reset socket, a timeout or a 5xx, also while the body is read, is retried after 5, 15 and 45 seconds; a 4xx is not.
const net = { fetch: ((url: string, init?: RequestInit) => fetch(url, init)) as unknown as typeof fetch, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
/** The test seam: the golden fetches go through this fetch and sleep, so a planted socket reset or 404 is answered without the network. */
export const routeGoldenFetchThrough = (fetchFn: typeof fetch, sleep: (ms: number) => Promise<void>): void => void Object.assign(net, { fetch: fetchFn, sleep });

/** The bytes of a document, or the stated reason it could not be read. */
async function download(url: string): Promise<{ bytes: Uint8Array } | { reason: string }> {
  let got: Uint8Array | null = null;
  const spec: ProducerSpec = {
    name: "golden-fetch", table: "none", licenceKey: null, enabled: false, killSwitchEnv: null,
    fetchDoc: async (ctx) => {
      got = new Uint8Array(await (await ctx.get(url, { headers: { "User-Agent": GOLDEN_UA }, buffer: true, timeoutMs: 90_000 })).arrayBuffer());
      return { text: "fetched" };
    },
    parse: () => ({ rows: [], warnings: [] }),
  };
  const run = await runProducer({ fetch: (u: string, i: never) => net.fetch(u, i), sleep: (ms: number) => net.sleep(ms), env: {}, sb: null } as never, { spec, dry: true });
  return got ? { bytes: got } : { reason: run.notes.join("; ").replace(/^golden-fetch: /, "") };
}

export type FetchedDoc = { ok: true; pages: string[]; bytes: number } | { ok: false; reason: string };
const memo = new Map<string, Promise<FetchedDoc>>();

async function pace(host: string): Promise<void> {
  const wait = (lastByHost.get(host) ?? 0) + 1100 - Date.now();
  lastByHost.set(host, Math.max(Date.now(), (lastByHost.get(host) ?? 0) + 1100));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** HTML to readable text: scripts and styles dropped, block ends become newlines, entities for the characters the pages use decoded. */
function htmlToText(html: string): string {
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
    const dl = await download(url);
    if ("reason" in dl) return { ok: false, reason: dl.reason };
    bytes = dl.bytes;
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
  // The licence register binds the golden tests as it binds the ladder and the worker: a host it bars is never asked, whatever documents.json says.
  const barred = licenceForbidsHost(new URL(url).hostname);
  if (barred) return Promise.resolve({ ok: false, reason: `licence_forbids: the licence register (${barred}) bars collecting from this host` });
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
