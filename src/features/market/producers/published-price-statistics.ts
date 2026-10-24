// Ported from old_repo/scripts/producers/market/refresh-published-price-statistics.mjs (lines 28-32, 67-150)
// Ported from old_repo/src/lib/market/refresh-published-price-statistics.mjs (lines 1-139)
// Ported from old_repo/scripts/producers/market/ratify-series-items.mjs (lines 15-90)
// Published price statistics: the display rows of the Market detail page, derived ONLY from ratified series-to-item entries (INV-047). A ratified entry whose item
// is not a live verified item is refused by name; an unratified entry never produces a row; a ratified series with no observation yet produces no row (never a dash).
import { isAdmissibleItem, ITEM_ADMISSIBLE_COLUMNS, type ItemAdmissibility } from "@/core/derived/admissible";
import { fetchAllRows, type Db } from "@/core/db";
import type { ParseOut, ProducerCtx, ProducerSpec } from "@/core/producers/runner";
import { keyOf, type Rec } from "@/core/producers/upsert-plan";

import { isRatified, readSeriesItemMap, type SeriesItemEntry, type SeriesItemMap } from "./market-series-items";

const SYMBOL: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };
function splitEnvelopeUnit(unit: string | null | undefined, currency: string | null | undefined): { symbol: string | null; suffix: string | null } {
  const symbol = (currency && SYMBOL[currency]) || null;
  if (!unit) return { symbol, suffix: null };
  const prefix = currency ? `${currency}/` : null;
  return { symbol, suffix: prefix && unit.startsWith(prefix) ? unit.slice(prefix.length - 1) : unit };
}
/** The display text of a price; a value that is not a finite number is refused (Number(null) is 0, and an absent observation must never be stored as "0.00": register surfaces:23). */
const formatValueDisplay = (value: unknown, currency: string | null | undefined): string => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) throw new RangeError(`formatValueDisplay: ${JSON.stringify(value)} is not a finite number`);
  return `${(currency && SYMBOL[currency]) || ""}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
export function addDaysIso(isoDate: string | null | undefined, days: number | null | undefined): string | null {
  if (!isoDate || days == null) return null;
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function latestPerSeries(rows: readonly Rec[]): Map<string, Rec> {
  const latest = new Map<string, Rec>();
  for (const r of rows) {
    const prev = latest.get(String(r.series_key));
    if (!prev || String(r.reference_period) > String(prev.reference_period)) latest.set(String(r.series_key), r);
  }
  return latest;
}

/** One display row per RATIFIED series that has an observation, in map order. */
function deriveDisplayRows(marketRows: readonly Rec[], o: { map: SeriesItemMap }): Rec[] {
  const { map } = o;
  const latest = latestPerSeries(marketRows);
  const out: Rec[] = [];
  map.forEach(([seriesKey, e], index) => {
    const row = latest.get(seriesKey);
    if (!isRatified(e) || !row || !Number.isFinite(Number(row.value_numeric)) || row.value_numeric === null) return;
    out.push({
      item_id: e.item_id, label: row.label, value_display: formatValueDisplay(row.value_numeric, row.currency as string), unit: splitEnvelopeUnit(row.unit as string, row.currency as string).suffix, context_line: e.context_line ?? null,
      severity_tone: e.severity_tone ?? null, source_tier: null, released_at: row.as_at_date ?? null, next_release_at: addDaysIso(row.reference_period as string, e.cadence_days), next_release_label: null, sort_order: index,
    });
  });
  return out;
}
const unmappedSeriesKeys = (marketRows: readonly Rec[], map: SeriesItemMap): string[] => {
  const ratified = new Set(map.filter(([, e]) => isRatified(e)).map(([k]) => k));
  return [...new Set(marketRows.map((r) => String(r.series_key)).filter((k) => k && !ratified.has(k)))].sort();
};

/** Ratify series against a mint artifact: only a series whose item reached minted_verified is ratified; everything else is skipped with its reason. Pure. */
export function ratifySeriesItemMap(rawMap: Record<string, SeriesItemEntry>, artifact: { per_item?: Array<{ id?: string; outcome?: string; item_id?: string }> }) {
  const byId = new Map((artifact?.per_item ?? []).filter((p) => typeof p?.id === "string").map((p) => [p.id as string, p]));
  const updated: Record<string, SeriesItemEntry> = {};
  const dispositions: Array<{ series_key: string; action: "ratified" | "skipped"; item_id?: string; reason?: string; outcome?: string | null }> = [];
  for (const [seriesKey, e] of Object.entries(rawMap)) {
    updated[seriesKey] = e;
    if (isRatified(e)) {
      dispositions.push({ series_key: seriesKey, action: "skipped", reason: "already_ratified" });
      continue;
    }
    const p = byId.get(seriesKey);
    if (p?.outcome === "minted_verified" && p.item_id) {
      updated[seriesKey] = { ...e, item_id: p.item_id, status: "ratified" };
      dispositions.push({ series_key: seriesKey, action: "ratified", item_id: p.item_id });
    } else dispositions.push({ series_key: seriesKey, action: "skipped", reason: p ? "outcome_not_verified" : "not_found_in_artifact", outcome: p?.outcome ?? null });
  }
  return { updated, dispositions };
}

async function readMarketRows(sb: Db, keys: string[]): Promise<Rec[]> {
  return fetchAllRows<Rec>((from, to) => sb.from("market_series").select("series_key, reference_period, label, value_numeric, unit, currency, as_at_date").in("series_key", keys).order("id", { ascending: true }).range(from, to) as never, { cap: 100_000 });
}

export const publishedPriceStatistics: ProducerSpec = {
  name: "refresh-published-price-statistics",
  table: "published_price_statistics",
  licenceKey: null,
  enabled: true,
  enabledRuling: "operator 2026-10-23: population hold lifted for the structured-data producers (ADR-023 code change; rulings file 2026-10-23 and 2026-10-24)",
  killSwitchEnv: "MARKET_PRODUCER_PUBLISHED_STATS_ENABLED",
  /** A dry run reads nothing (it has no database); an apply reads the ratified attachments from market_series_items and the observations of those series from market_series. An absent table throws, so the run is "failed" and mints nothing. */
  async fetchDoc(ctx: ProducerCtx) {
    if (!ctx.apply || !ctx.sb) return { text: JSON.stringify({ map: [], market: [] }) };
    const map = await readSeriesItemMap(ctx.sb);
    const keys = map.filter(([, e]) => isRatified(e)).map(([k]) => k);
    return { text: JSON.stringify({ map, market: keys.length ? await readMarketRows(ctx.sb, keys) : [] }) };
  },
  parse(doc): ParseOut<Rec> {
    const { map, market } = JSON.parse(doc.text ?? "{}") as { map: [string, SeriesItemEntry][]; market: Rec[] };
    const rows = deriveDisplayRows(market, { map });
    const unmapped = unmappedSeriesKeys(market, map);
    return { rows, warnings: unmapped.length ? [`unmapped series, not silently skipped (${unmapped.length}): ${unmapped.join(", ")}`] : [], counts: { ratified_entries: map.filter(([, e]) => isRatified(e)).length, unmapped: unmapped.length } };
  },
  /** INV-047: a row is written only for an item that is live and verified; any other is refused by name. */
  async resolve(ctx, rows) {
    const ids = [...new Set(rows.map((r) => String(r.item_id)))];
    const { data, error } = await (ctx.sb as Db).from("intelligence_items").select(`id, ${ITEM_ADMISSIBLE_COLUMNS}`).in("id", ids);
    if (error) throw new Error(`reading intelligence_items failed: ${error.message}`);
    const ok = new Set(((data ?? []) as Array<{ id: string } & ItemAdmissibility>).filter(isAdmissibleItem).map((i) => i.id));
    return { rows: rows.filter((r) => ok.has(String(r.item_id))), refused: rows.filter((r) => !ok.has(String(r.item_id))).map((r) => `item ${String(r.item_id)} (${String(r.label)}) is not a live verified item: not a ratified attachment`) };
  },
  plan: {
    read: (sb) => fetchAllRows<Rec>((from, to) => sb.from("published_price_statistics").select("id, item_id, label, value_display, unit, context_line, severity_tone, source_tier, released_at, next_release_at, next_release_label, sort_order").order("id", { ascending: true }).range(from, to) as never, { cap: 50_000 }),
    key: (r) => keyOf([r.item_id, r.label]),
    patchable: ["value_display", "unit", "context_line", "severity_tone", "source_tier", "released_at", "next_release_at", "next_release_label", "sort_order"],
    pk: "id",
  },
};
