// Ported from old_repo/scripts/lib/loop-run-id.mjs (lines 17-30)
// Ported from old_repo/scripts/lib/upstream-artifact.mjs (lines 18-47)
// The families as data: one per runtime, its owning module, the stage that runs it, what it hands to, and which counts prove it wrote.
import { z } from "zod";

import raw from "./data/families.json";

const family = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    owner: z.string().min(1),
    stage: z.string().nullable(),
    downstream: z.array(z.string()),
    terminal: z.string().optional(),
    writes: z.array(z.string()),
    note: z.string().optional(),
  })
  .strict();
export type Family = z.infer<typeof family>;

/** Validate the table: unique names, every downstream a real family, and either a downstream or a stated reason it ends. Returns the problems; it never throws (a registry that threw at import hid the real error). */
export function validateFamilies(rows: unknown = raw): { families: Family[]; problems: string[] } {
  const parsed = z.array(family).safeParse(rows);
  if (!parsed.success) return { families: [], problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const names = new Set<string>();
  const problems: string[] = [];
  for (const f of parsed.data) {
    if (names.has(f.name)) problems.push(`duplicate family ${f.name}`);
    names.add(f.name);
  }
  for (const f of parsed.data) {
    for (const d of f.downstream) if (!names.has(d)) problems.push(`${f.name}: downstream ${d} is not a family`);
    if (f.downstream.length === 0 && !f.terminal) problems.push(`${f.name}: no downstream and no stated reason it ends`);
  }
  return { families: parsed.data, problems };
}

export const FAMILIES: readonly Family[] = Object.freeze(validateFamilies().families);
export const familyOf = (name: string): Family | undefined => FAMILIES.find((f) => f.name === name);
export const stageFamily = (stage: string): Family | undefined => FAMILIES.find((f) => f.stage === stage);
