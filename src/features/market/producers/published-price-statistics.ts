// Ported from old_repo/scripts/producers/market/refresh-published-price-statistics.mjs (lines 28-32, 67-150)
// Ported from old_repo/src/lib/market/refresh-published-price-statistics.mjs (lines 1-139)
// Ported from old_repo/scripts/producers/market/ratify-series-items.mjs (lines 15-90)
// Published price statistics: the display rows of the Market detail page, derived ONLY from ratified series-to-item entries (INV-047). A ratified entry whose item
// is not a live verified item is refused by name; an unratified entry never produces a row; a ratified series with no observation yet produces no row (never a dash).
import { z } from "zod";

import { fetchAllRows, type Db } from "@/core/db";
import type { ParseOut, ProducerCtx, ProducerSpec } from "@/core/producers/runner";
import { keyOf, type Rec } from "@/core/producers/upsert-plan";

import raw from "./data/series-item-map.json";

const entry = z.object({ item_id: z.string().nullable(), status: z.string(), cadence_days: z.number().int().positive().nullable().optional(), context_line: z.string().nullable().optional(), severity_tone: z.enum(["critical", "high", "moderate", "low", "neutral"]).nullable().optional() }).strict();
export type SeriesItemEntry = z.infer<typeof entry>;
export type SeriesItemMap = ReadonlyArray<readonly [string, SeriesItemEntry]>;

export const loadSeriesItemMap = (rawMap: unknown = raw): SeriesItemMap => Object.freeze(Object.entries(z.record(z.string(), entry).parse(rawMap)).filter(([k]) => !k.startsWith("_")).map(([k, e]) => Object.freeze([k, e] as const)));
export const SERIES_ITEM_MAP: SeriesItemMap = loadSeriesItemMap();
/** Ratified means a minted item id AND the ratified status; anything pending is never a guessed attachment. */
export const isRatified = (e: SeriesItemEntry | null | undefined): boolean => e != null && !!e.item_id && e.status === "ratified";

const SYMBOL: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };
export function splitEnvelopeUnit(unit: string | null | undefined, currency: string | null | undefined): { symbol: string | null; suffix: string | null } {
  const symbol = (currency && SYMBOL[currency]) || null;
  if (!unit) return { symbol, suffix: null };
  const prefix = currency ? `${currency}/` : null;
  return { symbol, suffix: prefix && unit.startsWith(prefix) ? unit.slice(prefix.length - 1) : unit };
}
export const formatValueDisplay = (value: unknown, currency: string | null | undefined): string => `${(currency && SYMBOL[currency]) || ""}${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
export function deriveDisplayRows(marketRows: readonly Rec[], o: { map?: SeriesItemMap } = {}): Rec[] {
  const map = o.map ?? SERIES_ITEM_MAP;
  const latest = latestPerSeries(marketRows);
  const out: Rec[] = [];
  map.forEach(([seriesKey, e], index) => {
    const row = latest.get(seriesKey);
    if (!isRatified(e) || !row) return;
    out.push({
      item_id: e.item_id, label: row.label, value_display: formatValueDisplay(row.value_numeric, row.currency as string), unit: splitEnvelopeUnit(row.unit as string, row.currency as string).suffix, context_line: e.context_line ?? null,
      severity_tone: e.severity_tone ?? null, source_tier: null, released_at: row.as_at_date ?? null, next_release_at: addDaysIso(row.reference_period as string, e.cadence_days), next_release_label: null, sort_order: index,
    });
  });
  return out;
}
export const unmappedSeriesKeys = (marketRows: readonly Rec[], map: SeriesItemMap = SERIES_ITEM_MAP): string[] => {
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
  enabled: false,
  enabledRuling: "operator 2026-10-04: no data population before every build layer is complete",
  killSwitchEnv: "MARKET_PRODUCER_PUBLISHED_STATS_ENABLED",
  /** A dry run reads nothing (it has no database); the rows come from market_series on an apply. */
  async fetchDoc(ctx: ProducerCtx) {
    const keys = SERIES_ITEM_MAP.filter(([, e]) => isRatified(e)).map(([k]) => k);
    return { text: JSON.stringify(ctx.apply && ctx.sb && keys.length ? await readMarketRows(ctx.sb, keys) : []) };
  },
  parse(doc): ParseOut<Rec> {
    const market = JSON.parse(doc.text ?? "[]") as Rec[];
    const rows = deriveDisplayRows(market);
    const unmapped = unmappedSeriesKeys(market);
    return { rows, warnings: unmapped.length ? [`unmapped series, not silently skipped (${unmapped.length}): ${unmapped.join(", ")}`] : [], counts: { ratified_entries: SERIES_ITEM_MAP.filter(([, e]) => isRatified(e)).length, unmapped: unmapped.length } };
  },
  /** INV-047: a row is written only for an item that is live and verified; any other is refused by name. */
  async resolve(ctx, rows) {
    const ids = [...new Set(rows.map((r) => String(r.item_id)))];
    const { data, error } = await (ctx.sb as Db).from("intelligence_items").select("id, provenance_status, is_archived").in("id", ids);
    if (error) throw new Error(`reading intelligence_items failed: ${error.message}`);
    const ok = new Set(((data ?? []) as Array<{ id: string; provenance_status: string; is_archived: boolean }>).filter((i) => i.provenance_status === "verified" && !i.is_archived).map((i) => i.id));
    return { rows: rows.filter((r) => ok.has(String(r.item_id))), refused: rows.filter((r) => !ok.has(String(r.item_id))).map((r) => `item ${String(r.item_id)} (${String(r.label)}) is not a live verified item: not a ratified attachment`) };
  },
  plan: {
    read: (sb) => fetchAllRows<Rec>((from, to) => sb.from("published_price_statistics").select("id, item_id, label, value_display, unit, context_line, severity_tone, source_tier, released_at, next_release_at, next_release_label, sort_order").order("id", { ascending: true }).range(from, to) as never, { cap: 50_000 }),
    key: (r) => keyOf([r.item_id, r.label]),
    patchable: ["value_display", "unit", "context_line", "severity_tone", "source_tier", "released_at", "next_release_at", "next_release_label", "sort_order"],
    pk: "id",
  },
};
