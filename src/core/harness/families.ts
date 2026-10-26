// Ported from old_repo/scripts/lib/loop-run-id.mjs (lines 17-30)
// Ported from old_repo/scripts/lib/upstream-artifact.mjs (lines 18-47)
// The families as data: one per runtime, its owning module, the stage that runs it, what it hands to, and which counts prove it wrote (writes) and which only describe the work (reads).
import { z } from "zod";

import raw from "./data/families.json";

const family = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    owner: z.string().min(1),
    stage: z.string().nullable(),
    /** A family that reaches the network. Only these are held dry while the scrape cadence is off (rule 16 is about scraping); the analysis families work on stored data and honour the requested mode. */
    fetches: z.boolean().optional(),
    downstream: z.array(z.string()),
    terminal: z.string().optional(),
    writes: z.array(z.string()),
    /** The other count keys the family reports: totals, plans, refusals, sub-counts. A key in neither list is a write nobody counted (tests/turn/family-keys.test.ts). */
    reads: z.array(z.string()),
    note: z.string().optional(),
  })
  .strict();
export type Family = z.infer<typeof family>;

/** The table, parsed. It never throws at import (a registry that threw there hid the real error): a table that does not parse is empty, and tests/turn/harness.test.ts and the connection check hold the shipped table to its rules (unique names, every downstream a real family, a downstream or a stated reason it ends). */
export const FAMILIES: readonly Family[] = Object.freeze((() => {
  const parsed = z.array(family).safeParse(raw);
  return parsed.success ? parsed.data : [];
})());
export const familyOf = (name: string): Family | undefined => FAMILIES.find((f) => f.name === name);
