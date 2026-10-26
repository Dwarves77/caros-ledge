// New in ARM-3 (no old counterpart): a published freight-rate or fuel-price observation as a market_series row, authored from a stored capture. The value, its day and its unit are read by the rows-file author; this code checks
// that each stands in the quoted words (the figure as the page prints it, the day as an ISO date, the unit as a currency and a basis through the one unit normaliser) and that the cited host's register verdict is permitted (the register is the only licence source: a host it does not hold is refused).
import { SOURCE_LICENCES } from "@/core/contracts";
import { statutoryUnit } from "@/core/parse";
import { requireCitation, resolveEntityByName } from "@/core/producers/rows-file";
import type { Rec } from "@/core/producers/upsert-plan";
import { hostOf } from "@/core/shared";

import { afterMarketWrite } from "./market-series-delta";
import { need, refuse, rowsFileSpec, type ParsedRow } from "./rows-file-producers";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** The ISO day a text states as "27 Aug 2026", or null. */
function dayIn(text: string): string | null {
  const m = /\b(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})\b/.exec(text);
  const month = MONTHS.indexOf((m?.[2] ?? "").toLowerCase()) + 1;
  return m && month ? `${m[3]}-${String(month).padStart(2, "0")}-${(m[1] as string).padStart(2, "0")}` : null;
}
/** The register verdict that covers a host (its barred hosts, else the host of its terms page); null when the register holds none: "unregistered". */
function registerVerdict(url: string): { key: string; redistribution: string } | null {
  const h = hostOf(url) ?? "";
  const hit = Object.entries(SOURCE_LICENCES).find(([, l]) => (l.hosts ?? [hostOf(l.url ?? "") ?? ""]).some((x) => x && (h === x || h.endsWith(`.${x}`))));
  return hit ? { key: hit[0], redistribution: hit[1].redistribution } : null;
}

function parseSeriesRow(row: Rec, i: number, corridors: readonly { canonical_name: string; entity_id: string }[]): ParsedRow {
  const where = "market-series-rows";
  const c = requireCitation(row, i, where);
  need(row, ["series_key", "label", "value_numeric", "currency", "per", "as_at_date", "derivation", "origin_class"], where, i);
  const quotes = [c.quote, ...(c.also ?? [])].join("\n");
  const value = Number(row.value_numeric);
  const unit = statutoryUnit(`${row.currency} per ${row.per}`);
  if (!Number.isFinite(value) || !new RegExp(`(?<![\\d.])${value}(?!\\d)`).test(quotes.replace(/(\d),(?=\d{3})/g, "$1"))) return refuse(`row[${i}]: the quote does not contain the figure ${row.value_numeric}: a value is read from the cited words, never typed`);
  if (dayIn(quotes) !== row.as_at_date) return refuse(`row[${i}]: the quote states the day ${dayIn(quotes)}, not as_at_date ${row.as_at_date}`);
  if (unit !== `${row.currency}/${row.per}`) return refuse(`row[${i}]: "${row.currency} per ${row.per}" normalises to ${unit}, not ${row.currency}/${row.per}`);
  const verdict = registerVerdict(c.url);
  if (verdict && verdict.redistribution !== "permitted") return refuse(`row[${i}]: licence: ${hostOf(c.url)} is "${verdict.redistribution}" in the register (${verdict.key}); a price from it is a stated absence`);
  if (!verdict) return refuse(`row[${i}]: licence: ${hostOf(c.url)} has no register row (unregistered)`);
  let entity: string | null = null;
  if (row.lane != null) {
    entity = resolveEntityByName(corridors, String(row.lane));
    const tail = String(row.lane).split(":")[0]?.toLowerCase();
    if (!entity || !String(row.series_key).endsWith(`:${tail}`)) return refuse(`row[${i}]: lane "${row.lane}" ${entity ? `does not end series_key ${row.series_key}` : "is not a corridor entity"}: minting one is out of this producer's write set`);
  }
  const dbRow = { series_key: row.series_key, label: row.label, value_numeric: value, unit, currency: row.currency, derivation: row.derivation, origin_class: row.origin_class, source_key: verdict.key, source_ref: null, n_observations: null, method_version: "market-series-rows@1", as_at_date: row.as_at_date, reference_period: row.as_at_date, entity_id: entity };
  return { refused: false, citation: c, dbRow };
}

export const marketSeriesRows = rowsFileSpec({
  name: "market-series-rows", table: "market_series", entityKind: "corridor", killSwitchEnv: "MARKET_PRODUCER_SERIES_ROWS_ENABLED", pk: "id", keyFields: ["series_key", "reference_period"], storesSource: false,
  patchable: ["label", "value_numeric", "unit", "currency", "derivation", "origin_class", "source_ref", "entity_id"], parseRow: parseSeriesRow, after: afterMarketWrite,
  gap: "no $0 structured feed for container freight-rate indices or fuel price series; the input is a reviewed rows file",
  async settle(_sb, row, proof) {
    return { ...row, source_ref: `${proof.citation.title}; source ${proof.source_id}; capture ${proof.capture_id}; "${proof.citation.quote}"` };
  },
});
