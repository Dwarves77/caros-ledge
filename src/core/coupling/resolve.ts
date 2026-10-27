// The text resolver of the entity spine reads FORMAL CODES and nothing else (ADR-053; NO-ENTITY-LISTS-1, operator 2026-10-26: language comprehension belongs to the Reader, and no word list stands in for it):
//   - an instrument identifier it states ("Regulation (EU) 2023/2405", a CELEX id), matched by EQUALITY on the normalised key of the parse module (the rule resolveMention uses) against the instrument entities;
//   - a UN/LOCODE (two letters and three letters or digits, a whole upper-case token), matched by equality against the entities that hold it as an identifier.
// No name, alias, phrase or n-gram is matched: a carrier, a feedstock, a node, a country, an organisation, an instrument's title and an acronym resolve nothing here. Entities attach from typed columns and foreign keys (refs.ts).
import { findIdentifiers, sameIdentifier } from "@/core/parse";

export interface Match {
  entityId: string;
  /** identifier: an instrument number stated in the text; code: a UN/LOCODE. */
  how: "identifier" | "code";
  /** [start, end) in the text resolved. */
  span: [number, number];
}
export interface Resolver {
  /** UN/LOCODE to entity (null: two entities hold the code, so it resolves none). */
  codes: Map<string, string | null>;
  instruments: Map<string, { entityId: string; type: string | null }[]>;
}

/** The shape of a UN/LOCODE: a two-letter country code and three letters or digits, as a whole upper-case token. */
const LOCODE = /(?<![A-Za-z0-9])[A-Z]{2}[A-Z2-9]{3}(?![A-Za-z0-9])/g;

/** The resolver over the UN/LOCODEs the spine holds and the instrument entities (canonical names that are CELEX ids state their own identifier). Returns the count of codes dropped for ambiguity beside it. */
export function buildResolver(codes: Iterable<{ entity_id: string; code: string }>, instruments: readonly { entity_id: string; canonical_name: string }[]): Resolver & { ambiguous: number } {
  const byCode: Resolver["codes"] = new Map();
  for (const c of codes) byCode.set(c.code, byCode.has(c.code) && byCode.get(c.code) !== c.entity_id ? null : c.entity_id);
  const index = new Map<string, { entityId: string; type: string | null }[]>();
  for (const i of instruments) {
    const own = findIdentifiers(i.canonical_name).find((f) => f.kind === "instrument");
    if (own) index.set(own.key, [...(index.get(own.key) ?? []), { entityId: i.entity_id, type: own.type }]);
  }
  return { codes: byCode, instruments: index, ambiguous: [...byCode.values()].filter((v) => v === null).length };
}

/** Every entity the text names by a formal code, once each (the first mention): instrument numbers by equality, then UN/LOCODEs by equality. Pure. */
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
  return [...out.values()];
}
