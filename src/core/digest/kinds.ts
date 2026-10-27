// Ported from old_repo/scripts/drain/kinds.mjs (lines 1-221)
// The digest's kinds registry (DIGEST-1 D1): one row per judgement queue, as data. Each row names its exporter (the batch kit's), its authoring guide (the batch schema document and the ratified skills the
// author works under), its validator, its batch directory, its lease key and its apply path.
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
    validator: z.string(),
    batchDir: z.string().regex(/^drain\/batches\/[a-z-]+$/),
    batchRe: z.string(),
    batchPrefix: z.string(),
    leaseKey: z.string().nullable(),
    idKey: z.string(),
    applyPath: z.string(),
    applyStep: z.string(),
    needsPackets: z.boolean(),
    namesFile: z.boolean(),
    batchSize: z.number().int().positive(),
    maxBatchesPerRun: z.number().int().positive(),
    modes: z.record(z.string(), z.object({ label: z.string() })).optional(),
    windowDays: z.number().int().positive().optional(),
    lensOfMethod: z.record(z.string(), lens).optional(),
    conditionalMethods: z.array(z.string()).optional(),
    memberLens: z.record(z.string(), lens).optional(),
    /** The kind's briefs pass the second reader's binary judges before they enter a batch (DIGEST-1 D4). */
    secondReader: z.boolean().optional(),
    /** The typed blocks of the reader's emission contract (UNIFIED-PRB-DESIGN section 1), item-briefs only. */
    emission: z.array(z.string()).optional(),
  })
  .strict();
export type DigestKind = Omit<z.infer<typeof kind>, "batchRe"> & { batchRe: RegExp };

const menuCfg = z.object({ cap: z.number().int().positive(), maxLinked: z.number().int().positive(), maxRegion: z.number().int().nonnegative(), maxNeighbour: z.number().int().nonnegative(), maxDomain: z.number().int().nonnegative(), domainItems: z.number().int().positive(), aliases: z.number().int().positive(), kindOrder: z.array(z.string()).min(1) }).strict();
const parsed = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), menu: menuCfg, kinds: z.array(kind).min(1) }).parse(raw);
/** The version of this file's emission contract: it stamps every reader value as method_version reader@<version>. */
const KINDS_VERSION: string = parsed.version;
export const READER_METHOD = `reader@${KINDS_VERSION}`;
/** The candidate_entities menu: its cap, the linked-entity bounds, the aliases per line and the kind order that breaks a tie (TRIANGLE-TRACE Q3.4). */
export const MENU: Readonly<z.infer<typeof menuCfg>> = Object.freeze(parsed.menu);
/** The seven digest kinds, in plan order for ties (oldest pending still ranks first). */
export const DIGEST_KINDS: readonly DigestKind[] = Object.freeze(parsed.kinds.map((k) => Object.freeze({ ...k, batchRe: new RegExp(k.batchRe) })));
export const digestKind = (id: string): DigestKind | null => DIGEST_KINDS.find((k) => k.id === id) ?? null;

/** The skills an author of this kind works under: the kind's own, then the writer skill the item's format demands (item-briefs only). Pure. */
export function guideSkills(k: Pick<DigestKind, "authoringGuide">, formatType?: string): string[] {
  const writer = formatType ? k.authoringGuide.byFormat?.[formatType] : undefined;
  return writer ? [writer, ...k.authoringGuide.skills] : [...k.authoringGuide.skills];
}
