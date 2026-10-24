// New in CTX-5 (ADR-050). The shape of data/horizons.json: parsing refuses a file that is missing a key or whose tables disagree, so a half-written file stops the process at startup.
// Two separate axes. The windows (0-6m, 6-18m, 18-36m, ...) are the product's own vocabulary for how far ahead a theme member looks. The bands are the research assessment's (NOW to 2 years, NEAR to 5,
// MID to 10, FAR beyond; tests/contracts/horizon-bands.test.ts derives them from assess.ts). A window need not nest inside a band: each window lists the bands its month range overlaps, and the schema
// computes that overlap from the window's months and the band boundaries and refuses a file whose list disagrees (18-36m overlaps NOW and NEAR).
import { z } from "zod";

const SCHEMA = z
  .object({
    bands: z.array(z.object({ code: z.string().min(1), toYears: z.number().positive().nullable() })).min(1),
    windows: z.array(z.object({ token: z.string().min(1), toMonths: z.number().positive().nullable(), bands: z.array(z.string().min(1)).min(1) })).min(1),
    unplaced: z.string().min(1),
    excludedEventKinds: z.array(z.string().min(1)).min(1),
  })
  .superRefine((h, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const ascending = (ends: ReadonlyArray<number | null>, what: string) =>
      ends.forEach((to, i) => {
        const prev = i > 0 ? ends[i - 1] : 0;
        if ((to === null) !== (i === ends.length - 1)) fail(`${what}: only the last row is open-ended`);
        else if (to !== null && prev !== null && prev !== undefined && to <= prev) fail(`${what}: ends must ascend`);
      });
    ascending(h.bands.map((b) => b.toYears), "bands");
    ascending(h.windows.map((w) => w.toMonths), "windows");
    const names = [...h.bands.map((b) => b.code), ...h.windows.map((w) => w.token), h.unplaced];
    if (new Set(names).size !== names.length) fail("a band code, window token or the unplaced token is named twice");
    h.windows.forEach((w, i) => {
      const from = i === 0 ? 0 : (h.windows[i - 1]?.toMonths ?? 0);
      const computed = h.bands.filter((b, k) => {
        const bFrom = k === 0 ? 0 : (h.bands[k - 1]?.toYears ?? 0) * 12;
        return from < (b.toYears === null ? Infinity : b.toYears * 12) && (w.toMonths === null || w.toMonths > bFrom);
      });
      if (computed.map((b) => b.code).join() !== w.bands.join()) fail(`window ${w.token} lists bands [${w.bands}] but its months overlap [${computed.map((b) => b.code)}]`);
    });
  });

export type Horizons = z.infer<typeof SCHEMA>;
export const parseHorizons = (raw: unknown): Horizons => SCHEMA.parse(raw);
