// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): what may be an alias of a coupling in couplings.json (four characters or more, a letter in it, not a stoplist word). Since JOIN-1 (operator and scope reviewer, 2026-10-25) NO text is matched with this: the flywheel matches no free-text words,
// so the rule only validates the vocabulary file at load. It stays, with data/resolver.json, because couplings.json is part of the five released pattern methods (INV-202): removing an alias or this list needs the new versions that the follow-up batch registers.
import rules from "./data/resolver.json";

const stop = new Set(rules.stop);

/** The phrase a name or a text reads as: its letters and digits, lower case, single spaces. */
const phraseOf = (s: string): string => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");

/** Whether a name may be an alias: four characters or more, a letter in it, not a stoplist word or phrase. */
export const admitAlias = (alias: string): boolean => {
  const p = phraseOf(alias);
  return alias.trim().length >= rules.minLength && /\p{L}/u.test(p) && !stop.has(p);
};
