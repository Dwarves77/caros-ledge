// Ported from old_repo/src/lib/intake/record-facts.mjs (lines 55-190)
// Ported from old_repo/src/lib/intake/record-facts.mjs (lines 408-424)
// Ported from old_repo/src/lib/intake/record-facts.mjs (lines 490-503)
// Ported from old_repo/src/lib/intake/record-facts.mjs (lines 577-579)
// Ported from old_repo/src/lib/intake/record-facts.mjs (lines 685-686)
// Ported from old_repo/src/lib/intake/record-facts.mjs (lines 772-788)
// Ported from old_repo/src/lib/intake/record-facts-research.mjs (lines 14-31)
// Ported from old_repo/src/lib/intake/record-facts-research.mjs (lines 39-104)
// Every trigger table is DATA (data/triggers.json), compiled once here. Triggers LOCATE a span already in the text, never generate one;
// a slot with no match is an honest GAP. The research slots and the regulation-family slots share ONE table: the evidence and
// authority signals had two trigger lists for the same two slots, so a research payload carried the pair twice.
import { z } from "zod";

import raw from "./data/triggers.json";

const re = z.object({ source: z.string(), flags: z.string() });
const file = z.object({
  slots: z.record(z.string(), z.array(re)),
  binding_position: z.record(z.string(), z.array(re)),
  binding_position_priority: z.array(z.string()),
  due_date: z.array(re),
  eu_act_slots: z.array(z.string()),
  url_bearing_slots: z.array(z.string()),
  families: z.object({ regulation: z.array(z.string()), market: z.array(z.string()) }),
  family_slots: z.record(z.string(), z.array(z.string())),
});
const data = file.parse(raw);
type Re = z.infer<typeof re>;
const compile = (r: Re): RegExp => new RegExp(r.source, r.flags.includes("g") ? r.flags : `${r.flags}g`);
const compileAll = (rs: Re[]): RegExp[] => rs.map(compile);

export const SLOT_TRIGGERS: Readonly<Record<string, RegExp[]>> = Object.fromEntries(Object.entries(data.slots).map(([k, v]) => [k, compileAll(v)]));
export const BINDING_TRIGGERS: Readonly<Record<string, RegExp[]>> = Object.fromEntries(Object.entries(data.binding_position).map(([k, v]) => [k, compileAll(v)]));
export const BINDING_PRIORITY: readonly string[] = data.binding_position_priority;
export const DUE_DATE_TRIGGERS: RegExp[] = compileAll(data.due_date);
export const EU_ACT_SLOTS: readonly string[] = data.eu_act_slots;
export const URL_BEARING_SLOTS: ReadonlySet<string> = new Set(data.url_bearing_slots);
export const REGULATION_FAMILY: ReadonlySet<string> = new Set(data.families.regulation);
export const MARKET_FAMILY: ReadonlySet<string> = new Set(data.families.market);
export const FAMILY_SLOTS: Readonly<Record<string, readonly string[]>> = data.family_slots;
/** The research_finding row of the required-slots table (the default when a caller supplies none). */
export const RESEARCH_FINDING_REQUIRED_SLOTS: readonly string[] = ["decision_relevance", "does_not_resolve", "finding", "methodology_limits"];
