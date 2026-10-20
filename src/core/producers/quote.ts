// The one acceptance rule for a quoted source (R2b I5; register D:10, 69, 114). A statutory input's quote, a filing-grade year's quote and a producer row's citation quote were non-empty strings and nothing more: no capture was
// ever asked whether it holds the words, and the date beside the quote was not parsed. A quote now stands only when ALL of these hold: it names a STORED capture by id, that capture's text holds the quote verbatim
// (isVerbatim, criterion 3's own test), and the date it was verified on parses. The same function runs offline over exported capture text (the filing-grade derivation in CI) and online over the stored capture
// (acceptStoredQuote: the database finds the capture id, this function re-checks the text). A source whose reuse terms are unknown or prohibited is quoted only up to data/quotation.json's length (R2c C6). Nothing here guesses: every refusal names its reason.
import { z } from "zod";

import { isVerbatim } from "@/core/contracts/verbatim";
import type { Db } from "@/core/db";
import { readSourceByUrl } from "@/core/sources/register";
import { REUSE_TERMS, reuseTermsForHost, type ReuseTerms } from "@/core/sources/reuse-terms";

import quotationJson from "./data/quotation.json";

const QUOTATION = z.object({ cappedTerms: z.array(z.enum(REUSE_TERMS)), maxChars: z.number().int().positive() }).loose().parse(quotationJson);

export type QuoteRefusal = "quote_blank" | "no_capture_id" | "capture_text_missing" | "quote_not_in_capture" | "quote_over_cap" | "verified_at_unparseable";
export type QuoteVerdict = { ok: true; captureId: string; verifiedAt: string } | { ok: false; reason: QuoteRefusal; detail: string };

/** A calendar day (YYYY-MM-DD, optionally followed by a time) that exists and is not after `now` when given (a day of slack for the zone); the normalised day, or null. */
export function parseVerifiedAt(value: unknown, now?: Date): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  const day = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(s)?.[1];
  if (!day) return null;
  const at = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== day) return null;
  if (s.length > 10 && Number.isNaN(Date.parse(s))) return null;
  if (now && at > now.getTime() + 86_400_000) return null;
  return day;
}

export interface QuoteInput {
  quote: string | null | undefined;
  verifiedAt: unknown;
  /** The stored capture (agent_run_searches id) the quote stands on. */
  captureId: string | null | undefined;
  /** That capture's text. */
  captureText: string | null | undefined;
  /** The rights verdict of the capture's publisher (sources.reuse_terms; the class table's verdict for a host with no row; `unknown` when nothing is known): a source whose terms are unknown or prohibited is quoted only up to the cap. */
  reuseTerms: ReuseTerms;
  now?: Date;
}
export function acceptQuote(i: QuoteInput): QuoteVerdict {
  if (typeof i.quote !== "string" || !i.quote.trim()) return { ok: false, reason: "quote_blank", detail: "the quote is blank" };
  if (!i.captureId) return { ok: false, reason: "no_capture_id", detail: "the quote names no stored capture: a quote nobody checked against a capture is not accepted" };
  if (typeof i.captureText !== "string" || !i.captureText) return { ok: false, reason: "capture_text_missing", detail: `capture ${i.captureId} has no text to check the quote against` };
  if (!isVerbatim(i.captureText, i.quote)) return { ok: false, reason: "quote_not_in_capture", detail: `the quote is not verbatim in capture ${i.captureId}` };
  const length = i.quote.trim().length;
  if (QUOTATION.cappedTerms.includes(i.reuseTerms) && length > QUOTATION.maxChars) return { ok: false, reason: "quote_over_cap", detail: `the quote is ${length} characters; a source whose reuse terms are ${i.reuseTerms} may be quoted up to ${QUOTATION.maxChars}` };
  const day = parseVerifiedAt(i.verifiedAt, i.now);
  if (!day) return { ok: false, reason: "verified_at_unparseable", detail: `verified_at ${JSON.stringify(i.verifiedAt)} is not a date` };
  return { ok: true, captureId: i.captureId, verifiedAt: day };
}

/** The rights verdict stored on the registry row of the quoted page (sources.reuse_terms); the class table's verdict for a page with no row. A failed read throws: a quote is never accepted under a verdict nobody could read. */
async function reuseTermsOf(sb: Db, url: string): Promise<ReuseTerms> {
  const row = await readSourceByUrl(sb, url);
  if (!row) return reuseTermsForHost(url);
  const read = await sb.from("sources").select("reuse_terms").eq("id", row.id).maybeSingle();
  if (read.error) throw new Error(`reuse_terms read failed for ${url}: ${read.error.message}`);
  return ((read.data as { reuse_terms?: ReuseTerms | null } | null)?.reuse_terms ?? reuseTermsForHost(url));
}

/** The online form: the database names the newest stored capture of the URL that holds the quote (capture_holding_quote, migration 0077); acceptQuote re-checks its text. `texts` caches capture text for a run. */
export async function acceptStoredQuote(sb: Db, i: { url: string; quote: string; verifiedAt: unknown; now?: Date }, texts: Map<string, string> = new Map()): Promise<QuoteVerdict> {
  const day = parseVerifiedAt(i.verifiedAt, i.now);
  if (!day) return { ok: false, reason: "verified_at_unparseable", detail: `verified_at ${JSON.stringify(i.verifiedAt)} is not a date` };
  const found = await sb.rpc("capture_holding_quote", { p_url: i.url, p_quote: i.quote });
  if (found.error) throw new Error(`capture_holding_quote failed: ${found.error.message}`);
  const captureId = typeof found.data === "string" ? found.data : null;
  if (!captureId) return { ok: false, reason: "quote_not_in_capture", detail: `no stored capture of ${i.url} holds the quote verbatim` };
  let text = texts.get(captureId);
  if (text === undefined) {
    const row = await sb.from("agent_run_searches").select("result_content").eq("id", captureId).maybeSingle();
    if (row.error) throw new Error(`capture ${captureId} read failed: ${row.error.message}`);
    text = ((row.data as { result_content?: string | null } | null)?.result_content ?? "") as string;
    texts.set(captureId, text);
  }
  return acceptQuote({ quote: i.quote, verifiedAt: i.verifiedAt, captureId, captureText: text, reuseTerms: await reuseTermsOf(sb, i.url), ...(i.now ? { now: i.now } : {}) });
}
