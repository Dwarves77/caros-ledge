// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the alias seeds (data/alias-seeds.json): the short names and abbreviations of entities the spine already holds or the corpus names, found in the most frequent unresolved phrases of the claims, each with the page it is taken from and the
// verbatim quote (the same grounding as every coupling). An alias that is under four characters, has no letter or is on the stoplist is refused when the file loads. Written by the seeds pass as entity_aliases rows.
import { z } from "zod";

import { entityId } from "@/core/entities";

import { admitAlias } from "./alias-rules";
import { CITATION } from "./coupling";
import file from "./data/alias-seeds.json";

const seed = z.object({ target: z.object({ kind: z.enum(["organisation", "jurisdiction", "instrument"]), name: z.string().min(1) }).strict(), aliases: z.array(z.string().min(1)).min(1), citation: CITATION }).strict();
const parsed = z.object({ version: z.string().min(1), aliases: z.array(seed).min(1) }).strict().parse(file);
const refused = parsed.aliases.flatMap((s) => s.aliases.filter((a) => !admitAlias(a)));
if (refused.length) throw new Error(`alias-seeds.json: ${refused.join(", ")} may not be an alias (under four characters, no letter, or on the stoplist)`);

export const ALIAS_VERSION = parsed.version;
export const ALIAS_SEEDS = parsed.aliases.map((s) => ({ ...s, entityId: entityId(s.target.kind, s.target.name) }));
