// New in CTX-5 (ADR-050). The shape of data/horizons.json: parsing refuses a file that is missing a key or names a token outside its own lists, so a half-written file stops the process at startup.
import { z } from "zod";

const SCHEMA = z
  .object({
    order: z.array(z.string().min(1)).min(2),
    unplaced: z.string().min(1),
    bandToken: z.record(z.string(), z.string()),
    cutoffDays: z.record(z.string(), z.number().int().positive()),
    excludedEventKinds: z.array(z.string().min(1)).min(1),
  })
  .superRefine((h, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (h.order.includes(h.unplaced)) fail("unplaced must not be a horizon in order");
    for (const t of h.order.slice(0, -1)) if (!(t in h.cutoffDays)) fail(`cutoffDays has no key for ${t}`);
    for (const [band, t] of Object.entries(h.bandToken)) if (!h.order.includes(t)) fail(`bandToken ${band} names ${t}, which is not in order`);
  });

export type Horizons = z.infer<typeof SCHEMA>;
export const parseHorizons = (raw: unknown): Horizons => SCHEMA.parse(raw);
