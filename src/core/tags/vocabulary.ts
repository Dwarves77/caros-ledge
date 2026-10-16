// Ported from old_repo/src/lib/connections/derive-tags.mjs (lines 1-120, 206-440)
// Ported from old_repo/src/lib/connections/tag-labels.mjs (lines 1-102)
// Ported from old_repo/src/lib/connections/tag-aliases.mjs (lines 1-77)
// ONE vocabulary read for the tag layer: the closed field values come from the brief contract (the old module parsed another module's SOURCE TEXT at
// import and threw if a prose heading moved: B-2147/2148), adopted terms from vocabulary_terms, and the keyword synonyms, own-name suppressions,
// aliases, labels and acronyms are DATA (data/synonyms.json, data/labels.json). `vocabularyProblems()` is the former import-time self-check as a test.
import { z } from "zod";

import contractJson from "@/core/brief/data/contract.json";
import { COMPLIANCE_OBJECTS, TOPIC_TAGS } from "@/core/brief";
import { adoptedKeys, adoptedEntries, type AdoptedVocabulary } from "@/core/vocabulary/adopted";

import labelsJson from "./data/labels.json";
import synonymsJson from "./data/synonyms.json";

export const TAG_FIELDS = ["operational_scenario_tags", "compliance_object_tags", "topic_tags"] as const;
export type TagField = (typeof TAG_FIELDS)[number];
export const FIELD_CAPS: Readonly<Record<TagField, number>> = { operational_scenario_tags: 5, compliance_object_tags: 4, topic_tags: 3 };

const contract = z.object({ scenarioGlossary: z.array(z.object({ group: z.string(), values: z.array(z.string()) })) }).parse(contractJson);
export const SCENARIO_TAGS: readonly string[] = contract.scenarioGlossary.flatMap((g) => g.values);
export const TAG_VOCABULARY: Readonly<Record<TagField, readonly string[]>> = { operational_scenario_tags: SCENARIO_TAGS, compliance_object_tags: COMPLIANCE_OBJECTS, topic_tags: TOPIC_TAGS };

const synonyms = z.object({
  curated: z.record(z.string(), z.array(z.string())),
  suppressOwnName: z.array(z.string()),
  aliases: z.array(z.object({ field: z.enum(TAG_FIELDS), tag: z.string(), keywords: z.array(z.string()) })),
}).parse(synonymsJson);
const labels = z.object({ complianceObjects: z.record(z.string(), z.string()), scenarios: z.record(z.string(), z.string()), acronyms: z.array(z.string()) }).parse(labelsJson);
const ACRONYMS = new Set(labels.acronyms);

export interface KeywordEntry {
  field: TagField;
  tag: string;
  keywords: string[];
}
const ADOPTED_SCENARIO_SHAPE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/i;

/** `tag` and `tag` with hyphens as spaces (the forms a sentence writes). */
export const ownNameForms = (tag: string): string[] => {
  const spaced = tag.replace(/-/g, " ");
  return spaced === tag ? [tag] : [tag, spaced];
};
function dedupeKeywords(keywords: readonly string[]): string[] {
  const seen = new Set<string>();
  return keywords.filter((kw) => {
    const k = kw.toLowerCase();
    return seen.has(k) ? false : (seen.add(k), true);
  });
}
const suppressed = new Set(synonyms.suppressOwnName);
const aliasByKey = new Map<string, string[]>();
for (const a of synonyms.aliases) aliasByKey.set(`${a.field}|${a.tag}`, [...(aliasByKey.get(`${a.field}|${a.tag}`) ?? []), ...a.keywords]);

/** Every closed vocabulary tag with its keywords: own name (unless suppressed as noise), curated synonyms, and the alias phrases folded into the same entry. */
export const KEYWORD_MAP: readonly KeywordEntry[] = TAG_FIELDS.flatMap((field) =>
  TAG_VOCABULARY[field].map((tag) => {
    const key = `${field}|${tag}`;
    return { field, tag, keywords: dedupeKeywords([...(suppressed.has(key) ? [] : ownNameForms(tag)), ...(synonyms.curated[key] ?? []), ...(aliasByKey.get(key) ?? [])]) };
  }),
);

/** Keyword entries for adopted scenarios and compliance objects the closed vocabulary does not already hold. */
export function adoptedKeywordEntries(adopted: Partial<AdoptedVocabulary> | undefined): KeywordEntry[] {
  const out: KeywordEntry[] = [];
  const add = (field: TagField, kind: "scenario" | "compliance_object", shapeOk: (k: string) => boolean) => {
    const held = new Set(TAG_VOCABULARY[field].map((t) => t.toLowerCase()));
    for (const e of adoptedEntries(adopted, kind)) {
      if (held.has(e.key.toLowerCase()) || !shapeOk(e.key)) continue;
      out.push({ field, tag: e.key, keywords: dedupeKeywords([...ownNameForms(e.key), ...(e.label ? [e.label] : [])]) });
    }
  };
  add("operational_scenario_tags", "scenario", (k) => ADOPTED_SCENARIO_SHAPE.test(k));
  add("compliance_object_tags", "compliance_object", () => true);
  return out;
}

/** The live vocabulary per field: the closed values plus the adopted terms. */
export function heldVocabulary(adopted?: Partial<AdoptedVocabulary>): Record<TagField, Set<string>> {
  return {
    topic_tags: new Set(TAG_VOCABULARY.topic_tags),
    compliance_object_tags: new Set([...TAG_VOCABULARY.compliance_object_tags, ...adoptedKeys(adopted, "compliance_object")]),
    operational_scenario_tags: new Set([...TAG_VOCABULARY.operational_scenario_tags, ...adoptedKeys(adopted, "scenario")]),
  };
}

/** The former import-time self-checks, as a list of problems: a synonym, suppression or alias that names a tag the vocabulary does not hold, and a tag with no keyword. */
export function vocabularyProblems(): string[] {
  const held = heldVocabulary();
  const problems: string[] = [];
  const check = (what: string, key: string) => {
    const i = key.indexOf("|");
    const field = key.slice(0, i) as TagField;
    if (!held[field]?.has(key.slice(i + 1))) problems.push(`${what} names tag ${key}, which is not in the live vocabulary`);
  };
  for (const k of Object.keys(synonyms.curated)) check("curated synonym", k);
  for (const k of synonyms.suppressOwnName) check("own-name suppression", k);
  for (const a of synonyms.aliases) check("alias", `${a.field}|${a.tag}`);
  for (const e of KEYWORD_MAP) if (!e.keywords.length) problems.push(`${e.field}|${e.tag} has zero keywords`);
  return problems;
}

const key = (s: unknown): string => String(s ?? "").trim().toLowerCase();
function humanise(slug: string): string {
  return key(slug).split("-").filter(Boolean).map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(" ");
}
export const labelForScenario = (slug: unknown): string => (typeof slug !== "string" || !slug.trim() ? "" : (labels.scenarios[key(slug)] ?? humanise(slug)));
export const labelForComplianceObject = (slug: unknown): string => (typeof slug !== "string" || !slug.trim() ? "" : (labels.complianceObjects[key(slug)] ?? humanise(slug)));
/** "a, b and c". */
export function joinLabels(list: readonly unknown[] | null | undefined): string {
  const l = (list ?? []).filter((x): x is string => typeof x === "string" && x !== "");
  return l.length <= 1 ? l.join("") : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
}
