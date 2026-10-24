// New in CTX-5 (ADR-050). The shape of data/horizons.json: parsing refuses a file that is missing a key or whose table is inconsistent, so a half-written file stops the process at startup.
// The bands are the ones the research assessment implements (NOW to 2 years, NEAR to 5, MID to 10, FAR beyond; tests/contracts/horizon-bands.test.ts derives them from assess.ts), and every theme token
// lies inside exactly one band: the last token of a band ends where the band ends.
import { z } from "zod";

const upper = z.number().positive().nullable();
const SCHEMA = z
  .object({
    bands: z.array(z.object({ code: z.string().min(1), toYears: upper })).min(1),
    tokens: z.array(z.object({ token: z.string().min(1), band: z.string().min(1), toYears: upper })).min(1),
    unplaced: z.string().min(1),
    excludedEventKinds: z.array(z.string().min(1)).min(1),
  })
  .superRefine((h, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const ascending = (rows: ReadonlyArray<{ toYears: number | null }>, what: string) =>
      rows.forEach((r, i) => {
        const prev = i > 0 ? rows[i - 1]?.toYears : 0;
        if ((r.toYears === null) !== (i === rows.length - 1)) fail(`${what}: only the last row is open-ended`);
        else if (r.toYears !== null && prev !== null && prev !== undefined && r.toYears <= prev) fail(`${what}: toYears must ascend`);
      });
    ascending(h.bands, "bands");
    ascending(h.tokens, "tokens");
    const names = [...h.bands.map((b) => b.code), ...h.tokens.map((t) => t.token), h.unplaced];
    if (new Set(names).size !== names.length) fail("a band code, token or the unplaced token is named twice");
    let at = 0;
    for (const t of h.tokens) {
      const idx = h.bands.findIndex((b) => b.code === t.band);
      if (idx < 0 || idx < at) fail(`token ${t.token} names band ${t.band}, which is unknown or out of order`);
      at = Math.max(at, idx);
    }
    for (const b of h.bands) {
      const last = h.tokens.filter((t) => t.band === b.code).at(-1);
      if (!last || last.toYears !== b.toYears) fail(`band ${b.code} must end where its last token ends`);
    }
  });

export type Horizons = z.infer<typeof SCHEMA>;
export const parseHorizons = (raw: unknown): Horizons => SCHEMA.parse(raw);
