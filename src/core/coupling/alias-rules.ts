// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): what may be an alias, and how a phrase is read. A name or alias shorter than four characters, one with no letter, or one that is a dictionary word or a generic term of the corpus (the stoplist in data/resolver.json) resolves nothing:
// "Union", "Commission" and "Act" name no entity, and a three-letter acronym names several. Matching is on the phrase: lower case, the letters and digits of the text in order, everything between them one space.
import rules from "./data/resolver.json";

const stop = new Set(rules.stop);

/** The phrase a name or a text reads as: its letters and digits, lower case, single spaces. */
export const phraseOf = (s: string): string => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");

/** Whether a name may be an alias: four characters or more, a letter in it, not a stoplist word or phrase. */
export const admitAlias = (alias: string): boolean => {
  const p = phraseOf(alias);
  return alias.trim().length >= rules.minLength && /\p{L}/u.test(p) && !stop.has(p);
};
