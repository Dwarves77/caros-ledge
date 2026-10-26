// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt), reduced in JOIN-1 under ADR-053: what may be a name or alias of a coupling in couplings.json, and how a phrase is read. The closed ontology of couplings.json (its names and aliases) is the only word list the
// claims pass matches: a curated, closed vocabulary of carriers, feedstocks, nodes, corridors and mandates, never a growing English stoplist. A name or alias shorter than four characters, or one with no letter, is refused when the file loads (a three-letter abbreviation
// names several things); a country name, a host, an organisation, a title and an acronym are not in the file and resolve nothing.
const MIN_LENGTH = 4;

/** The phrase a name or a text reads as: its letters and digits, lower case, single spaces. */
export const phraseOf = (s: string): string => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");

/** Whether a name may be an alias: four characters or more, with a letter in it. */
export const admitAlias = (alias: string): boolean => alias.trim().length >= MIN_LENGTH && /\p{L}/u.test(phraseOf(alias));
