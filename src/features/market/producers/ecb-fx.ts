// Ported from old_repo/scripts/producers/market/ecb-fx-producer.mjs (lines 24-194)
// ECB daily euro reference rates into market_series (four currencies). The attribute parser reads either quote style, in any attribute order.
import type { ParseOut, ProducerSpec } from "@/core/producers/runner";
import type { Rec } from "@/core/producers/upsert-plan";

import { marketSeriesBase, stampEntity } from "./market-series-delta";

const ECB_XML_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const CURRENCIES: Readonly<Record<string, string>> = Object.freeze({ USD: "US dollar", GBP: "Pound sterling", CNY: "Chinese yuan renminbi", JPY: "Japanese yen" });
const ECB_KEY_PREFIX = "ecb-fx";

const ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const attrsOf = (s: string): Record<string, string> => Object.fromEntries([...String(s ?? "").matchAll(ATTR_RE)].map((m) => [m[1] as string, (m[2] ?? m[3]) as string]));

const GESMES = /xmlns:gesmes\s*=\s*(?:"http:\/\/www\.gesmes\.org\/xml\/2002-08-01"|'http:\/\/www\.gesmes\.org\/xml\/2002-08-01')/;
const SENDER = /<gesmes:name>\s*European Central Bank\s*<\/gesmes:name>/;

/** Parse the single-day ECB document. A document that is not recognisably that document yields no rows and the reason; nothing is fabricated. */
function parseEcbFxXml(xmlText: string): { rows: Rec[]; warnings: string[] } {
  const text = String(xmlText ?? "");
  const dates: string[] = [];
  const currencies: Record<string, string>[] = [];
  for (const m of text.matchAll(/<Cube\b([^>]*)>/g)) {
    const a = attrsOf(m[1] as string);
    if (a.time !== undefined) dates.push(a.time);
    else if (a.currency !== undefined) currencies.push(a);
  }
  const none = (w: string) => ({ rows: [] as Rec[], warnings: [w] });
  if (!dates.length) return none('no <Cube time="YYYY-MM-DD"> element found: not a recognisable ECB daily-rates document');
  if (dates.length > 1) return none(`${dates.length} dated <Cube time="..."> elements found (${dates.join(", ")}): expected exactly one; this producer reads only the single daily-rates document, never ECB's multi-day history file`);
  if (!GESMES.test(text)) return none('no xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" namespace declaration found: not a recognisable ECB daily-rates document');
  if (!SENDER.test(text)) return none("no <gesmes:name>European Central Bank</gesmes:name> sender element found: not a recognisable ECB daily-rates document");
  const date = dates[0] as string;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return none(`<Cube time="${date}"> is not a well-formed YYYY-MM-DD date: not a recognisable ECB daily-rates document`);
  const warnings: string[] = [];
  const rows: Rec[] = [];
  const seen = new Set<string>();
  for (const a of currencies) {
    const ccy = a.currency as string;
    if (!/^[A-Z]{3}$/.test(ccy)) warnings.push(`bad currency code "${ccy}" (rate "${a.rate}"): not 3 uppercase letters: row skipped`);
    else if (seen.has(ccy)) warnings.push(`duplicate <Cube currency="${ccy}"> in the document: first occurrence kept, later one(s) ignored`);
    else {
      seen.add(ccy);
      const label = CURRENCIES[ccy];
      const rate = Number(a.rate);
      if (!label) warnings.push(`currency "${ccy}" is not in this lane's closed vocabulary (${Object.keys(CURRENCIES).join(", ")}): row skipped, not fabricated`);
      else if (!Number.isFinite(rate) || rate <= 0) warnings.push(`bad rate "${a.rate}" for currency "${ccy}": row skipped`);
      else {
        rows.push({
          series_key: `${ECB_KEY_PREFIX}:eur-${ccy.toLowerCase()}`, label: `EUR/${ccy} — ECB euro foreign exchange reference rate (${label})`, value_numeric: rate, unit: `${ccy}/EUR`, currency: ccy,
          derivation: "observed", origin_class: "official", source_key: "ecb", source_ref: `ECB euro foreign exchange reference rates, ${date}`, n_observations: null, method_version: null, as_at_date: date, reference_period: date,
        });
      }
    }
  }
  if (!rows.length && !warnings.length) warnings.push(`<Cube time="${date}"> found but no recognised-currency rate elements inside it`);
  return { rows, warnings };
}

/** The byte count, a content-type and the first 200 characters of a document, for the warning a parse that yields nothing carries. */
function formatSourceEvidence(xmlText: string, meta?: { status?: number | null; contentType?: string | null }): string {
  const text = String(xmlText ?? "");
  const parts: string[] = [];
  if (meta?.status != null) parts.push(`HTTP ${meta.status}`);
  if (meta?.contentType) parts.push(`content-type "${meta.contentType}"`);
  parts.push(`${Buffer.byteLength(text, "utf8")} byte(s)`, `first 200 chars: ${JSON.stringify(text.slice(0, 200).replace(/\s+/g, " ").trim())}`);
  return parts.join(", ");
}

export const ecbFx: ProducerSpec = {
  name: "ecb-fx",
  ...marketSeriesBase(ECB_KEY_PREFIX),
  licenceKey: "ecb",
  enabled: true,
  enabledRuling: "operator 2026-10-23: population hold lifted for the structured-data producers (ADR-023 code change; rulings file 2026-10-23 and 2026-10-24)",
  killSwitchEnv: "MARKET_PRODUCER_ECB_FX_ENABLED",
  async fetchDoc(ctx) {
    const res = await ctx.get(ECB_XML_URL, { headers: { accept: "application/xml, text/xml" } });
    return { text: await res.text(), meta: { status: res.status, contentType: res.headers.get("content-type") } };
  },
  parse(doc, ctx): ParseOut<Rec> {
    const { rows, warnings } = parseEcbFxXml(doc.text ?? "");
    if (!rows.length) warnings.push(`evidence: ${formatSourceEvidence(doc.text ?? "", doc.meta as never)}`);
    return { rows: stampEntity(rows, ctx), warnings };
  },
};
