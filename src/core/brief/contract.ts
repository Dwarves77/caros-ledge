// Ported from old_repo/src/lib/agent/system-prompt.ts (lines 1-593)
// Ported from old_repo/src/lib/agent/contract-version.mjs (lines 1-3)
// Ported from old_repo/src/lib/agent/parse-output.ts (lines 8-192)
// Ported from old_repo/src/lib/agent/canonical-pipeline.ts (lines 756-779)
// The synthesis contract as DATA: ONE field table drives the validator (validate.ts), the write (features/intake/pipeline.ts)
// and the author's instruction text, so a count or a vocabulary cannot drift between them again (B-0221, B-1004).
import { z } from "zod";

import contractJson from "./data/contract.json";

const field = z.object({
  name: z.string(),
  kind: z.string(),
  required: z.boolean(),
  extra: z.boolean().optional(),
  onlyFormat: z.string().optional(),
  description: z.string(),
});
const section = z.object({ key: z.string(), order: z.number(), heading: z.string(), headingAlts: z.array(z.string()).optional(), conditional: z.boolean(), roles: z.array(z.enum(["timeline", "do_now", "sources"])).optional() });
const format = z.object({ formatType: z.string(), itemTypes: z.array(z.string()), grounding: z.enum(["span", "corroboration", "matrix"]), sections: z.array(section) });
const contract = z.object({
  version: z.string(),
  severity: z.array(z.object({ label: z.string(), db: z.string(), priority: z.string(), meaning: z.string() })),
  dbSeverityExtra: z.array(z.string()),
  priorities: z.array(z.string()),
  urgencyTiers: z.array(z.object({ value: z.string(), meaning: z.string() })),
  topicTags: z.array(z.object({ tag: z.string(), meaning: z.string() })),
  signalBands: z.array(z.object({ band: z.string(), meaning: z.string() })),
  themes: z.array(z.string()),
  themeCandidateMap: z.record(z.string(), z.string()),
  complianceObjects: z.array(z.object({ group: z.string(), values: z.array(z.string()) })),
  scenarioGlossary: z.array(z.object({ group: z.string(), values: z.array(z.string()) })),
  caps: z.object({ topicTags: z.number(), scenarioTags: z.number(), complianceTags: z.number(), complianceCandidates: z.number(), candidateMaxLength: z.number(), intersectionSummary: z.number() }),
  mentionedTerms: z.object({ kinds: z.array(z.string()), max: z.number(), textMax: z.number() }),
  claimKinds: z.array(z.string()),
  fields: z.array(field),
  formats: z.array(format),
});

const C = contract.parse(contractJson);

export type BriefField = z.infer<typeof field>;
export type SectionDef = z.infer<typeof section>;
export type FormatDef = z.infer<typeof format>;

export const CONTRACT_VERSION = C.version;
/** The 26 contract fields (full_brief plus the 25 metadata fields). The two optional extras live in BRIEF_EXTRA_FIELDS. */
export const BRIEF_FIELDS: readonly BriefField[] = C.fields.filter((f) => !f.extra);
export const BRIEF_EXTRA_FIELDS: readonly BriefField[] = C.fields.filter((f) => f.extra);
export const COMPLIANCE_OBJECTS: readonly string[] = C.complianceObjects.flatMap((g) => g.values);
export const TOPIC_TAGS: readonly string[] = C.topicTags.map((t) => t.tag);
export const SIGNAL_BANDS: readonly string[] = C.signalBands.map((b) => b.band);
export const THEMES: readonly string[] = C.themes;
export const SEVERITIES = C.severity;
export const PRIORITIES: readonly string[] = C.priorities;
export const URGENCY_TIERS: readonly string[] = C.urgencyTiers.map((u) => u.value);
export const DB_SEVERITY_EXTRA: readonly string[] = C.dbSeverityExtra;
export const CAPS = C.caps;
export const MENTIONED_TERMS_CONTRACT = C.mentionedTerms;
export const CLAIM_KINDS: readonly string[] = C.claimKinds;
export const FORMATS: readonly FormatDef[] = C.formats;
export const FORMAT_TYPES: readonly string[] = C.formats.map((f) => f.formatType);

const dup = (all: readonly string[]) => all.find((v, i) => all.indexOf(v) !== i);
for (const [name, list] of [["compliance object", COMPLIANCE_OBJECTS], ["topic tag", TOPIC_TAGS], ["field", C.fields.map((f) => f.name)]] as const) {
  const d = dup(list);
  if (d) throw new Error(`brief contract: duplicate ${name} ${d}`);
}
for (const s of C.severity) if (!C.priorities.includes(s.priority)) throw new Error(`brief contract: severity ${s.label} maps to unknown priority ${s.priority}`);

export interface AdoptedTerms {
  compliance_object?: { key: string }[];
  theme?: { key: string }[];
  scenario?: { key: string }[];
}


