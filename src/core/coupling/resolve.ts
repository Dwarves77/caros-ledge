// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt), reduced in JOIN-1 under ADR-053 (operator and scope reviewer, 2026-10-25): language comprehension belongs to the Reader, not to a scanner. The text resolver of the entity spine reads three things and nothing else:
//   - an instrument identifier it states ("Regulation (EU) 2023/2405", a CELEX id), matched by EQUALITY on the normalised key of the parse module (the rule resolveMention uses) against the instrument entities;
//   - a UN/LOCODE (two letters and three letters or digits, a whole upper-case token), matched by equality against the entities that hold it as an identifier;
//   - a name or alias of the closed ontology of couplings.json (a carrier, a feedstock, a node, a corridor, a mandate), the longest exact phrase, case-insensitive, never fuzzy. The ontology is curated data under review, not a stoplist that grows with the corpus.
// A country name, an organisation's name or host, an instrument's title and a three-letter acronym are not in the ontology and resolve nothing: jurisdictions attach from typed columns, publisher hosts stay on sources. The claims pass resolves through this one function (refs.ts).
import { findIdentifiers, sameIdentifier } from "@/core/parse";

import { phraseOf } from "./alias-rules";

export interface Match {
  entityId: string;
  /** identifier: an instrument number stated in the text; code: a UN/LOCODE; name: a name or alias of the closed ontology. */
  how: "identifier" | "code" | "name";
  /** [start, end) in the text resolved. */
  span: [number, number];
}
export interface NameSource {
  entity_id: string;
  name: string;
}
export interface Resolver {
  /** phrase to entity (null: the phrase names two entities and resolves none). */
  phrases: Map<string, string | null>;
  longest: number;
  /** UN/LOCODE to entity (null: two entities hold the code, so it resolves none). */
  codes: Map<string, string | null>;
  instruments: Map<string, { entityId: string; type: string | null }[]>;
}

/** The shape of a UN/LOCODE: a two-letter country code and three letters or digits, as a whole upper-case token. */
const LOCODE = /(?<![A-Za-z0-9])[A-Z]{2}[A-Z2-9]{3}(?![A-Za-z0-9])/g;

/** The resolver over the ontology's names, the UN/LOCODEs the spine holds and the instrument entities (canonical names that are CELEX ids state their own identifier). Returns the count of names dropped for ambiguity beside it. */
export function buildResolver(names: Iterable<NameSource>, codes: Iterable<{ entity_id: string; code: string }>, instruments: readonly { entity_id: string; canonical_name: string }[]): Resolver & { ambiguous: number } {
  const phrases: Resolver["phrases"] = new Map();
  let longest = 1;
  for (const n of names) {
    const p = phraseOf(n.name);
    if (!p) continue;
    phrases.set(p, phrases.has(p) && phrases.get(p) !== n.entity_id ? null : n.entity_id);
    longest = Math.max(longest, p.split(" ").length);
  }
  const byCode: Resolver["codes"] = new Map();
  for (const c of codes) byCode.set(c.code, byCode.has(c.code) && byCode.get(c.code) !== c.entity_id ? null : c.entity_id);
  const index = new Map<string, { entityId: string; type: string | null }[]>();
  for (const i of instruments) {
    const own = findIdentifiers(i.canonical_name).find((f) => f.kind === "instrument");
    if (own) index.set(own.key, [...(index.get(own.key) ?? []), { entityId: i.entity_id, type: own.type }]);
  }
  return { phrases, longest, codes: byCode, instruments: index, ambiguous: [...phrases.values()].filter((v) => v === null).length + [...byCode.values()].filter((v) => v === null).length };
}

/** Every entity the text names, once each (the first mention): instrument numbers by equality, UN/LOCODEs by equality, then ontology names as the longest exact phrase at each position. Pure. */
export function resolveText(text: string, r: Resolver): Match[] {
  const out = new Map<string, Match>();
  for (const f of findIdentifiers(text)) {
    if (f.kind !== "instrument") continue;
    for (const hit of r.instruments.get(f.key) ?? []) if (sameIdentifier(f, { key: f.key, type: hit.type }) && !out.has(hit.entityId)) out.set(hit.entityId, { entityId: hit.entityId, how: "identifier", span: [f.start, f.end] });
  }
  for (const m of text.matchAll(LOCODE)) {
    const entity = r.codes.get(m[0]);
    if (entity && !out.has(entity)) out.set(entity, { entityId: entity, how: "code", span: [m.index, m.index + m[0].length] });
  }
  const tokens = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ t: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length }));
  for (let i = 0; i < tokens.length; ) {
    let step = 1;
    for (let n = Math.min(r.longest, tokens.length - i); n >= 1; n -= 1) {
      const entity = r.phrases.get(tokens.slice(i, i + n).map((x) => x.t).join(" "));
      if (entity === undefined) continue;
      if (entity && !out.has(entity)) out.set(entity, { entityId: entity, how: "name", span: [(tokens[i] as { start: number }).start, (tokens[i + n - 1] as { end: number }).end] });
      step = n;
      break;
    }
    i += step;
  }
  return [...out.values()];
}
