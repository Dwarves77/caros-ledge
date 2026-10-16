// Ported from old_repo/src/lib/sources/api-transport.mjs (lines 1-96)
// Ported from old_repo/src/lib/sources/transport-escalation.mjs (lines 98-125)
import { hostOf } from "@/core/shared";
import { log } from "@/core/shared/log";

import { toText } from "./classify-body";
import { type FetchDeps, type TransportResult } from "./direct";
import { assertFetchAllowed } from "./hold";
import { cleanCtl } from "./policy";

export const FEDERAL_REGISTER_API_BASE = "https://www.federalregister.gov/api/v1";
export const FEDERAL_REGISTER_PORTAL_URL = "https://www.federalregister.gov";
export const ECFR_API_BASE = "https://www.ecfr.gov/api";
export const ECFR_PORTAL_URL = "https://www.ecfr.gov";
const UA = { "user-agent": "Mozilla/5.0 (compatible; CarosLedge/1.0)" };
const API_TIMEOUT_MS = 25_000;

/** The official JSON API base for a host, or null when the host has no API transport. */
export function apiEndpointFor(url: string): string | null {
  const h = hostOf(url);
  if (/(^|\.)federalregister\.gov$/.test(h)) return FEDERAL_REGISTER_API_BASE;
  if (/(^|\.)ecfr\.gov$/.test(h)) return ECFR_API_BASE;
  return null;
}

function clip(full: string, max: number): TransportResult {
  const t = (cleanCtl(full) || "").replace(/\s+/g, " ").trim();
  return { status: 200, text: t.length > 200 ? t.slice(0, max) : "", truncated: t.length > max, fullLength: t.length, cap: max };
}

/** federalregister.gov: the document number in the URL path to the JSON API, then its raw text; the JSON title and abstract when the text is absent or thin. */
async function fetchFederalRegisterDocument(url: string, deps: FetchDeps, max: number, apiBase: string): Promise<TransportResult | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  const segs = new URL(url).pathname.split("/").filter(Boolean);
  const i = segs.indexOf("documents");
  const docNum = i >= 0 && segs.length > i + 4 ? segs[i + 4] : null;
  if (!docNum) return null;
  const jr = await doFetch(`${apiBase}/documents/${encodeURIComponent(docNum)}.json?fields[]=title&fields[]=abstract&fields[]=raw_text_url`, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!jr.ok) return { status: jr.status, text: "", truncated: false, fullLength: 0, cap: max };
  const doc = (await jr.json()) as { title?: string; abstract?: string; raw_text_url?: string };
  if (doc.raw_text_url) {
    try {
      const tr = await doFetch(doc.raw_text_url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(API_TIMEOUT_MS) });
      if (tr.ok) {
        const c = clip(toText(await tr.text()), max);
        if (c.text) return c;
      }
    } catch (e) {
      log.warn("[fetch-api] raw text unavailable, falling back to the title and abstract", { url: doc.raw_text_url, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const summary = [doc.title, doc.abstract].filter(Boolean).join(". ").trim();
  return { status: 200, text: summary.length > 200 ? summary.slice(0, max) : "", truncated: summary.length > max, fullLength: summary.length, cap: max };
}

/** eCFR versioner: the full title XML as of a concrete date (a bare /current/ URL carries none, so it returns null and the HTML transports hold). */
async function fetchEcfrTitle(url: string, deps: FetchDeps, max: number, apiBase: string): Promise<TransportResult | null> {
  const path = new URL(url).pathname;
  const title = path.match(/title-(\d+)/);
  const date = path.match(/\/on\/(\d{4}-\d{2}-\d{2})\//);
  if (!title || !date) return null;
  const xr = await (deps.fetchImpl ?? fetch)(`${apiBase}/versioner/v1/full/${date[1]}/title-${title[1]}.xml`, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!xr.ok) return { status: xr.status, text: "", truncated: false, fullLength: 0, cap: max };
  return clip(toText(await xr.text()), max);
}

/** Host-dispatching entry: null when the host has no API transport or the URL carries no usable document identifier. The hold gate runs first. */
export async function fetchDocumentApi(url: string, deps: FetchDeps, opts: { max: number }): Promise<TransportResult | null> {
  const apiBase = apiEndpointFor(url);
  if (!apiBase) return null;
  await assertFetchAllowed(url, deps.caller, deps);
  const host = hostOf(url);
  if (/(^|\.)federalregister\.gov$/.test(host)) return fetchFederalRegisterDocument(url, deps, opts.max, apiBase);
  if (/(^|\.)ecfr\.gov$/.test(host)) return fetchEcfrTitle(url, deps, opts.max, apiBase);
  return null;
}
