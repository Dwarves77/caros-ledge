// Ported from old_repo/src/lib/llm/skill-loader.ts (lines 80-212)
// The platform guide the Assistant can quote: the sections of the platform's own skill that describe its vocabulary (source weighting, severity labels, formats, pages, topics, jurisdictions), shipped as
// data. A passage is matched to the question by word, shown whole and named as the platform guide, never paraphrased and never presented as an answer about an item.
import { z } from "zod";

import passagesJson from "./data/skill-passages.json";

const passage = z.object({ id: z.string().min(1), heading: z.string().min(1), keywords: z.array(z.string().min(1)).min(1), text: z.string().min(1) });
export type SkillPassage = z.infer<typeof passage>;
const SKILL_PASSAGES: readonly SkillPassage[] = Object.freeze(z.array(passage).min(1).parse(passagesJson));

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []);

/** The passages whose curated keywords share a WHOLE word with the question, best match first (ties keep the guide's order), at most `max`. No match is an empty list: nothing is guessed. */
export function matchPassages(question: string, max = 2, pool: readonly SkillPassage[] = SKILL_PASSAGES): SkillPassage[] {
  const asked = words(question);
  return pool
    .map((p, order) => ({ p, order, score: [...words(p.keywords.join(" "))].filter((w) => asked.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, max)
    .map((x) => x.p);
}
