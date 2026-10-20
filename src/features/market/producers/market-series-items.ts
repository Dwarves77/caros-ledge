import { z } from "zod";

import { boundedRead, isMissingObject, type Db } from "@/core/db";

const entry = z.object({ item_id: z.string().nullable(), status: z.string(), cadence_days: z.number().int().positive().nullable().optional(), context_line: z.string().nullable().optional(), severity_tone: z.enum(["critical", "high", "moderate", "low", "neutral"]).nullable().optional() }).strict();
export type SeriesItemEntry = z.infer<typeof entry>;
export type SeriesItemMap = ReadonlyArray<readonly [string, SeriesItemEntry]>;

/** The series-to-item map from entries keyed by series key, each refused outside the shape (the table's own vocabulary). */
const loadSeriesItemMap = (rawMap: unknown): SeriesItemMap => Object.freeze(Object.entries(z.record(z.string(), entry).parse(rawMap)).filter(([k]) => !k.startsWith("_")).map(([k, e]) => Object.freeze([k, e] as const)));
/** Ratified means a minted item id AND the ratified status; anything pending is never a guessed attachment. */
export const isRatified = (e: SeriesItemEntry | null | undefined): boolean => e != null && !!e.item_id && e.status === "ratified";

/**
 * The series-to-item attachments (market_series_items, migrations 0029, 0030, 0044 and 0045) as the map the published-price-statistics producer reads: the table is the one home, so the producers and the ratification
 * cannot drift (IMP-084). Throws on a failed read; the table absent (production before the cutover) throws a message naming the migrations, so the producer's run returns "failed" with that note and mints nothing.
 */
export async function readSeriesItemMap(sb: Db): Promise<SeriesItemMap> {
  const r = await boundedRead<Record<string, unknown>>((limit) => sb.from("market_series_items").select("series_key, item_id, status, cadence_days, context_line, severity_tone").order("series_key", { ascending: true }).limit(limit), { limit: 200 });
  if (r.error) throw new Error(isMissingObject(r.error) ? "market_series_items is absent (migrations 0029, 0030, 0044 and 0045 are not applied): no series is ratified, nothing is minted" : `market_series_items read failed: ${r.error.message}`);
  if (r.truncated) throw new Error("market_series_items reached its 200-row bound: the attachment list would be incomplete");
  return loadSeriesItemMap(Object.fromEntries(r.data.map(({ series_key, ...e }) => [String(series_key), e])));
}
