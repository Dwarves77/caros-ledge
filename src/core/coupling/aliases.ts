// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the alias seeds (data/alias-seeds.json): the short names and abbreviations of entities the spine already holds or the corpus names, found in the most frequent unresolved phrases of the claims, each with the page it is taken from and the
// verbatim quote (the same grounding as every coupling). An alias that is under four characters, has no letter or is on the stoplist is refused when the file loads. Written by the seeds pass as entity_aliases rows.
import { z } from "zod";

import { entityId } from "@/core/entities";

import { admitAlias, phraseOf } from "./alias-rules";
import { CITATION, couplingByKey } from "./coupling";
import file from "./data/alias-seeds.json";
import rules from "./data/resolver.json";

const seed = z.object({ target: z.object({ kind: z.enum(["organisation", "jurisdiction", "instrument"]), name: z.string().min(1) }).strict(), aliases: z.array(z.string().min(1)).min(1), citation: CITATION }).strict();
const parsed = z.object({ version: z.string().min(1), aliases: z.array(seed).min(1) }).strict().parse(file);
const refused = parsed.aliases.flatMap((s) => s.aliases.filter((a) => !admitAlias(a)));
if (refused.length) throw new Error(`alias-seeds.json: ${refused.join(", ")} may not be an alias (under four characters, no letter, or on the stoplist)`);

const acronym = z
  .object({ acronym: z.string().regex(/^[A-Z][A-Z0-9]{2}$/), expansion: z.string().min(4), entity: z.union([z.object({ key: z.string().min(1) }).strict(), z.object({ kind: z.enum(["organisation", "jurisdiction", "instrument"]), name: z.string().min(1) }).strict()]), citation: CITATION })
  .strict();
const listed = z.array(acronym).parse(rules.acronyms);
const bare = listed.filter((a) => !phraseOf(a.citation.quote).includes(phraseOf(a.expansion)) && !a.citation.quote.includes(`(${a.acronym})`));
if (bare.length) throw new Error(`resolver.json: the quote of ${bare.map((a) => a.acronym).join(", ")} does not state the expansion`);

export const ALIAS_VERSION = parsed.version;
/** The listed acronyms with the entity each expands to: a coupling by key, or an organisation, jurisdiction or instrument by name. */
export const ACRONYMS = listed.map((a) => ({ ...a, entityId: "key" in a.entity ? (couplingByKey(a.entity.key)?.entityId as string) : entityId(a.entity.kind, a.entity.name) }));
export const ALIAS_SEEDS = parsed.aliases.map((s) => ({ ...s, entityId: entityId(s.target.kind, s.target.name) }));
