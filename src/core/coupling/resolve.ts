// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the text resolver of the entity spine. A piece of text resolves to entities two ways, both read from the database the spine already holds:
// an instrument identifier it states ("Regulation (EU) 2023/2405", a CELEX id) is matched by EQUALITY on the normalised key of the parse module (the rule resolveMention uses) against the instrument entities' canonical names; and a NAME is matched as an exact phrase,
// case-insensitive, longest phrase first, never fuzzy: every entity's canonical and display name, its identifiers (host, CELEX, ISO codes), the title of the instrument an item carries, the country name of a jurisdiction, and every row of entity_aliases.
// A name that may not be an alias (alias-rules.ts) or that names two entities is dropped when the resolver is built, never guessed. The claims pass, the typed-column pass and the tag pass all resolve through this one function.
import { findIdentifiers, sameIdentifier } from "@/core/parse";

import { admitAlias, phraseOf } from "./alias-rules";

export interface Match {
  entityId: string;
  /** alias: a row of entity_aliases; name: a canonical or display name, an identifier or a title; identifier: an instrument number stated in the text. */
  how: "alias" | "name" | "identifier";
  /** [start, end) in the text resolved. */
  span: [number, number];
}
export interface NameSource {
  entity_id: string;
  name: string;
  how: "alias" | "name";
}
export interface Resolver {
  /** phrase to entity (null: the phrase names two entities and resolves none) and how the name was learned. */
  phrases: Map<string, { entityId: string | null; how: "alias" | "name" }>;
  longest: number;
  instruments: Map<string, { entityId: string; type: string | null }[]>;
}

/** The resolver over every name source and the instrument entities (canonical names that are CELEX ids state their own identifier). Returns the count of names dropped for ambiguity beside it. */
export function buildResolver(names: Iterable<NameSource>, instruments: readonly { entity_id: string; canonical_name: string }[]): Resolver & { ambiguous: number } {
  const phrases: Resolver["phrases"] = new Map();
  let longest = 1;
  for (const n of names) {
    if (!admitAlias(n.name)) continue;
    const p = phraseOf(n.name);
    const held = phrases.get(p);
    if (held && held.entityId !== n.entity_id) held.entityId = null;
    else if (!held) phrases.set(p, { entityId: n.entity_id, how: n.how });
    longest = Math.max(longest, p.split(" ").length);
  }
  const index = new Map<string, { entityId: string; type: string | null }[]>();
  for (const i of instruments) {
    const own = findIdentifiers(i.canonical_name).find((f) => f.kind === "instrument");
    if (own) index.set(own.key, [...(index.get(own.key) ?? []), { entityId: i.entity_id, type: own.type }]);
  }
  return { phrases, longest, instruments: index, ambiguous: [...phrases.values()].filter((v) => v.entityId === null).length };
}

/** Every entity the text names, once each (the first mention): instrument numbers by equality, then names as the longest exact phrase at each position. Pure. */
export function resolveText(text: string, r: Resolver): Match[] {
  const out = new Map<string, Match>();
  for (const f of findIdentifiers(text)) {
    if (f.kind !== "instrument") continue;
    for (const hit of r.instruments.get(f.key) ?? []) if (sameIdentifier(f, { key: f.key, type: hit.type }) && !out.has(hit.entityId)) out.set(hit.entityId, { entityId: hit.entityId, how: "identifier", span: [f.start, f.end] });
  }
  const tokens = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ t: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length }));
  for (let i = 0; i < tokens.length; ) {
    let step = 1;
    for (let n = Math.min(r.longest, tokens.length - i); n >= 1; n -= 1) {
      const hit = r.phrases.get(tokens.slice(i, i + n).map((x) => x.t).join(" "));
      if (!hit) continue;
      if (hit.entityId && !out.has(hit.entityId)) out.set(hit.entityId, { entityId: hit.entityId, how: hit.how, span: [(tokens[i] as { start: number }).start, (tokens[i + n - 1] as { end: number }).end] });
      step = n;
      break;
    }
    i += step;
  }
  return [...out.values()];
}
