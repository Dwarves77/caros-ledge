// Ported from old_repo/scripts/drain/kinds.mjs (lines 1-221)
// The digest's kinds registry (DIGEST-1 D1): one row per judgement queue, as data. Each row names its exporter (the batch kit's), its authoring guide (the batch schema document and the ratified skills the
// author works under), its validator, its batch directory, its lease key and its apply path. `applyPending` is a stated reason, never a stub: the admin kind has no validator and no apply until DIGEST-1 PR B.
import { z } from "zod";

import raw from "./data/kinds.json";

export const LENSES = ["supply_demand_bottleneck", "penalty_abatement_crossover", "capital_offtake_grant"] as const;
export const WINDOWS = ["0-6m", "6-18m", "18-36m"] as const;
const lens = z.enum(LENSES);
const guide = z.object({ schema: z.string().regex(/^docs\/authoring\/[a-z-]+\.md$/), skills: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1), byFormat: z.record(z.string(), z.string()).optional() }).strict();
const kind = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string(),
    exporter: z.string(),
    authoringGuide: guide,
    validator: z.string().nullable(),
    batchDir: z.string().regex(/^drain\/batches\/[a-z-]+$/),
    batchRe: z.string(),
    batchPrefix: z.string(),
    leaseKey: z.string().nullable(),
    idKey: z.string(),
    applyPath: z.string().nullable(),
    applyStep: z.string(),
    applyPending: z.string().nullable(),
    needsPackets: z.boolean(),
    namesFile: z.boolean(),
    batchSize: z.number().int().positive(),
    maxBatchesPerRun: z.number().int().positive(),
    modes: z.record(z.string(), z.object({ label: z.string() })).optional(),
    windowDays: z.number().int().positive().optional(),
    lensOfMethod: z.record(z.string(), lens).optional(),
    conditionalMethods: z.array(z.string()).optional(),
    memberLens: z.record(z.string(), lens).optional(),
  })
  .strict()
  .refine((k) => (k.applyPending === null) === (k.applyPath !== null && k.validator !== null), { message: "a kind has both a validator and an apply path, or a stated reason it has neither" });
export type DigestKind = Omit<z.infer<typeof kind>, "batchRe"> & { batchRe: RegExp };

const parsed = z.object({ kinds: z.array(kind).min(1) }).parse(raw);
/** The seven digest kinds, in plan order for ties (oldest pending still ranks first). */
export const DIGEST_KINDS: readonly DigestKind[] = Object.freeze(parsed.kinds.map((k) => Object.freeze({ ...k, batchRe: new RegExp(k.batchRe) })));
export const digestKind = (id: string): DigestKind | null => DIGEST_KINDS.find((k) => k.id === id) ?? null;

/** The skills an author of this kind works under: the kind's own, then the writer skill the item's format demands (item-briefs only). Pure. */
export function guideSkills(k: Pick<DigestKind, "authoringGuide">, formatType?: string): string[] {
  const writer = formatType ? k.authoringGuide.byFormat?.[formatType] : undefined;
  return writer ? [writer, ...k.authoringGuide.skills] : [...k.authoringGuide.skills];
}
