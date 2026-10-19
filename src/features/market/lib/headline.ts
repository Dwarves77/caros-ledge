// Ported from old_repo/src/lib/market/series-family.mjs (lines 1-180)
// Ported from old_repo/src/lib/market/headline-series-select.mjs (lines 1-156)
// The headline row (INV-253, operator ruling steps 1-4, 2026-09-08): a series with no computed change is not a headline; the rest fold into families (one card per signal, the others folded under it with a COMPUTED count,
// never a literal); cards order fuels, carbon, FX, other; five are visible and the rest are reachable.
import { z } from "zod";

import raw from "./data/families.json";
import { prefixOf, producerFor, producerOrder } from "./registry";
import type { ProducerGroup, SeriesBoard, SeriesDisplayRow } from "./series-board";

/** The ruling's own order: fuels, carbon (when a series exists), FX, other indices. */
export const FAMILY_CLASS_ORDER = ["fuel", "carbon", "fx", "index"] as const;
export const HEADLINE_VISIBLE_CAP = 5;

const family = z
  .object({ familyKey: z.string(), familyClass: z.enum(FAMILY_CLASS_ORDER), label: z.string(), freightMode: z.enum(["road", "ocean", "air"]).nullable(), memberNoun: z.string(), memberSeriesKeys: z.array(z.string()).min(1), primarySeriesKey: z.string() })
  .strict();
export type SeriesFamily = z.infer<typeof family> & { declared?: boolean };
export const SERIES_FAMILIES: readonly SeriesFamily[] = Object.freeze(z.array(family).parse(raw));

/** One series to its family. Never null: an unclaimed series is a family of its own, classed by its producer (or "index" for an unregistered prefix). */
export function resolveSeriesFamily(seriesKey: string, families: readonly SeriesFamily[] = SERIES_FAMILIES): SeriesFamily & { declared: boolean } {
  const declared = families.find((f) => f.memberSeriesKeys.includes(seriesKey));
  if (declared) return { ...declared, declared: true };
  const familyClass = producerFor(prefixOf(seriesKey))?.familyClass ?? "index";
  return { familyKey: `${familyClass}:${seriesKey}`, familyClass, label: "", freightMode: null, memberNoun: "series", memberSeriesKeys: [seriesKey], primarySeriesKey: seriesKey, declared: false };
}

export interface HeadlineCard {
  familyKey: string;
  familyClass: string;
  label: string;
  freightMode: string | null;
  row: SeriesDisplayRow;
  group: ProducerGroup | null;
  /** The OTHER eligible members of the family, folded onto this card: the family's eligible member count minus one. */
  fold: { count: number; noun: string };
  memberSeriesKeys: string[];
}
export interface HeadlineSelection {
  cards: HeadlineCard[];
  visible: HeadlineCard[];
  overflow: HeadlineCard[];
  familiesShown: number;
  totalSeries: number;
  excludedSeriesKeys: string[];
}

/** True when the series has at least one computed window change. */
export const hasComputedDelta = (d: SeriesDisplayRow["deltas"] | null | undefined): boolean => !!d && [d.delta1w, d.delta1m, d.deltaYoY].some((w) => typeof w?.value === "number" && Number.isFinite(w.value));

const rank = (c: string): number => {
  const i = (FAMILY_CLASS_ORDER as readonly string[]).indexOf(c);
  return i === -1 ? FAMILY_CLASS_ORDER.length : i;
};

/** The caption over the headline strip: the cards are families and the total is series, so it says both and never a fraction of one over the other (register surfaces:18). */
export const headlineCaption = (s: Pick<HeadlineSelection, "cards" | "totalSeries">): string => `${s.cards.length} ${s.cards.length === 1 ? "family" : "families"} from ${s.totalSeries} series`;

export function selectHeadlineSeries(board: Pick<SeriesBoard, "groups" | "unregistered">, o: { cap?: number; families?: readonly SeriesFamily[] } = {}): HeadlineSelection {
  const located = [...board.groups.flatMap((g) => g.series.map((row) => ({ row, group: g }))), ...board.unregistered.map((row) => ({ row, group: null as ProducerGroup | null }))];
  const eligible = located.filter((x) => hasComputedDelta(x.row.deltas));
  const byFamily = new Map<string, { fam: SeriesFamily; members: typeof eligible }>();
  for (const x of eligible) {
    const fam = resolveSeriesFamily(x.row.seriesKey, o.families);
    byFamily.set(fam.familyKey, { fam, members: [...(byFamily.get(fam.familyKey)?.members ?? []), x] });
  }
  const cards: HeadlineCard[] = [...byFamily.values()].map(({ fam, members }) => {
    // The declared primary when it is itself eligible; otherwise the member with the most observations behind it, the series key breaking ties.
    const sorted = [...members].sort((a, b) => b.row.observationCount - a.row.observationCount || a.row.seriesKey.localeCompare(b.row.seriesKey));
    const declaredPrimary = sorted.find((m) => m.row.seriesKey === fam.primarySeriesKey);
    const primary = declaredPrimary ?? (sorted[0] as (typeof sorted)[number]);
    const rest = sorted.filter((m) => m !== primary);
    return {
      familyKey: fam.familyKey,
      familyClass: fam.familyClass,
      // The declared label describes the declared primary; another member shows its own label.
      label: (declaredPrimary && fam.label) || primary.row.label || primary.row.seriesKey,
      freightMode: fam.freightMode,
      row: primary.row,
      group: primary.group,
      fold: { count: rest.length, noun: fam.memberNoun },
      memberSeriesKeys: [primary.row.seriesKey, ...rest.map((m) => m.row.seriesKey)],
    };
  });
  cards.sort((a, b) => rank(a.familyClass) - rank(b.familyClass) || (a.freightMode ? 0 : 1) - (b.freightMode ? 0 : 1) || producerOrder(a.row.seriesKey) - producerOrder(b.row.seriesKey) || a.familyKey.localeCompare(b.familyKey));
  const cap = Math.max(0, o.cap ?? HEADLINE_VISIBLE_CAP);
  const visible = cards.slice(0, cap);
  return { cards, visible, overflow: cards.slice(cap), familiesShown: visible.length, totalSeries: located.length, excludedSeriesKeys: located.filter((x) => !hasComputedDelta(x.row.deltas)).map((x) => x.row.seriesKey) };
}
