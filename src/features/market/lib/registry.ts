// Ported from old_repo/src/lib/market/series-registry.mjs (lines 1-252)
// The six market-series producers AS DATA. `producer` names the runtime side (the spec in features/market/producers); everything the database holds (licence, attribution, url) is read from data_sources, never restated here.
import { z } from "zod";

import raw from "./data/producers.json";

const entry = z
  .object({
    keyPrefix: z.string().regex(/^[a-z0-9-]+$/),
    familyClass: z.enum(["fuel", "carbon", "fx", "index"]),
    name: z.string().min(1),
    implemented: z.boolean(),
    cadence: z.string().min(1),
    cadenceDays: z.number().int().positive().nullable(),
    sourceKey: z.string().nullable(),
    producer: z.string().nullable(),
    sourceName: z.string().min(1),
    sourceUrl: z.string().nullable(),
  })
  .strict();
export type Producer = z.infer<typeof entry>;

export const PRODUCERS: readonly Producer[] = Object.freeze(z.array(entry).parse(raw));

export const prefixOf = (seriesKey: unknown): string => String(seriesKey ?? "").split(":")[0] ?? "";
export const producerFor = (keyPrefix: string): Producer | undefined => PRODUCERS.find((p) => p.keyPrefix === keyPrefix);
/** True iff the full "prefix:rest" key belongs to a producer that writes today. */
const isImplementedSeriesKey = (seriesKey: unknown): boolean => !!producerFor(prefixOf(seriesKey))?.implemented;
/** The registry position of a series' producer, the intended reading order. An unknown prefix sorts after every known one. */
export const producerOrder = (seriesKey: string): number => {
  const i = PRODUCERS.findIndex((p) => p.keyPrefix === prefixOf(seriesKey));
  return i === -1 ? PRODUCERS.length : i;
};
