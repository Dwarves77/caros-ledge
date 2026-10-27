// Ported from old_repo/src/lib/contracts/vocabularies.mjs (lines 1-563)
// Ported from old_repo/src/lib/classification/vocab.mjs (lines 4-9)
import { z } from "zod";

import raw from "./data/vocabularies.json";

/** One member of a closed vocabulary; the optional fields are the per-vocabulary flags the readers use. */
const entry = z
  .object({
    code: z.string(),
    label: z.string(),
    order: z.number().optional(),
    strength: z.number().optional(),
    isPresent: z.boolean().optional(),
    contractable: z.boolean().optional(),
    statutory: z.boolean().optional(),
    degraded: z.boolean().optional(),
    citableAsFact: z.boolean().optional(),
    admissibleInCalculation: z.boolean().optional(),
    corridorOnly: z.boolean().optional(),
    orgRoles: z.array(z.string()).optional(),
  })
  .loose();
export type VocabEntry = z.infer<typeof entry>;

const REQUIRED = ["obs_status", "origin_class", "binding_position", "duty_holder_class", "freshness", "coverage_state", "transport_mode", "derivation"];
const file = z.object({
  pedigree_axes: z.array(z.string()).length(5),
  mode_aliases: z.record(z.string(), z.string()),
  refresh_period_days: z.record(z.string(), z.number().nullable()),
  vocabularies: z.record(z.string(), z.record(z.string(), entry)).superRefine((all, ctx) => {
    for (const name of REQUIRED) if (!all[name]) ctx.addIssue({ code: "custom", message: `vocabulary ${name} is missing` });
    for (const [name, members] of Object.entries(all)) {
      for (const [key, e] of Object.entries(members)) if (e.code !== key) ctx.addIssue({ code: "custom", message: `${name}.${key} carries code ${e.code}` });
    }
  }),
});

function deepFreeze<T extends object>(o: T): T {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}

const data = deepFreeze(file.parse(raw));
type Vocab = Readonly<Record<string, VocabEntry>>;
const get = (name: string): Vocab => data.vocabularies[name] as Vocab;

/** Every closed vocabulary by name; the acceptance checks iterate this, never a hand-kept list. */
export const VOCABULARIES: Readonly<Record<string, Vocab>> = data.vocabularies;
export const OBS_STATUS = get("obs_status");
export const ORIGIN_CLASS = get("origin_class");
export const DERIVATION = get("derivation");
export const FRESHNESS = get("freshness");
const TRANSPORT_MODES = get("transport_mode");
export const DUTY_HOLDER_CLASSES = get("duty_holder_class");
/** GRAPH-GROW-1: the shape of a duty-holder class token. The class is open; DUTY_HOLDER_CLASSES above is only the labels and org roles of the tokens the platform already renders. */
export const DUTY_HOLDER_TOKEN = /^[a-z][a-z0-9_]*$/;
export const PEDIGREE_AXES: readonly string[] = data.pedigree_axes;
export const REFRESH_PERIOD_DAYS: Readonly<Record<string, number | null>> = data.refresh_period_days;

const byOrder = (a: VocabEntry, b: VocabEntry) => (a.order ?? 0) - (b.order ?? 0);
const modes = Object.values(TRANSPORT_MODES).sort(byOrder);
/** Modes a single leg, and therefore an emission factor, may carry (excludes `multimodal`). */
export const LEG_MODE_CODES: readonly string[] = modes.filter((m) => !m.corridorOnly).map((m) => m.code);

/** True when the code denotes an absent observation; an unknown code counts as missing. A missing value is never zero-filled. */
export const isMissing = (obsStatus: unknown): boolean => {
  const e = OBS_STATUS[String(obsStatus)];
  return e ? e.isPresent !== true : true;
};

/**
 * The weakest of several origin classes: an aggregate is only as trustworthy as its weakest input.
 * An unknown code collapses to `community`; an empty set returns null (provenance is never invented).
 */
export function weakestOriginClass(codes: Iterable<string> | null | undefined): string | null {
  let weakest: VocabEntry | null = null;
  for (const c of codes ?? []) {
    const e = ORIGIN_CLASS[c];
    if (!e) return "community";
    if (!weakest || (e.strength ?? 0) < (weakest.strength ?? 0)) weakest = e;
  }
  return weakest ? weakest.code : null;
}

export const citableAsFact = (code: string): boolean => ORIGIN_CLASS[code]?.citableAsFact === true;

/** Canonical transport mode (`ocean` is canonical; `sea` and `maritime` are input aliases, never stored), or null. Never guesses. */
export function normaliseMode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (Object.hasOwn(TRANSPORT_MODES, key)) return key;
  return Object.hasOwn(data.mode_aliases, key) ? (data.mode_aliases[key] as string) : null;
}

export const isValid = (vocabName: string, value: unknown): boolean => !!VOCABULARIES[vocabName] && Object.hasOwn(VOCABULARIES[vocabName], String(value));

/** Members of a vocabulary in declared display order. */
export const orderedValues = (vocabName: string): VocabEntry[] => Object.values(VOCABULARIES[vocabName] ?? {}).sort(byOrder);
