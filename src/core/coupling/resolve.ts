// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the text resolver of the entity spine. A piece of text resolves to entities two ways, both read from the database the spine already holds: an instrument identifier it states ("Regulation (EU) 2023/2405", a CELEX id)
// is matched by EQUALITY on the normalised key of the parse module (the rule resolveMention uses) against the instrument entities' canonical names, and a name or alias in entity_aliases is matched on word boundaries (an alias of three characters or fewer is
// case-sensitive, so "OPS" is never "ops"). Nothing is guessed: no match is no ref. The claims pass, the typed-column pass and the tag pass all resolve through this one function.
import { findIdentifiers, sameIdentifier } from "@/core/parse";

export interface Match {
  entityId: string;
  how: "alias" | "identifier";
  /** [start, end) in the text resolved. */
  span: [number, number];
}
export interface Resolver {
  names: { entityId: string; re: RegExp }[];
  instruments: Map<string, { entityId: string; type: string | null }[]>;
}
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The resolver over entity_aliases rows and the instrument entities (canonical names are CELEX ids, so each states its own identifier). */
export function buildResolver(aliases: readonly { entity_id: string; alias: string }[], instruments: readonly { entity_id: string; canonical_name: string }[]): Resolver {
  const names = aliases.map((a) => ({ entityId: a.entity_id, re: new RegExp(`(?<![A-Za-z0-9])${escapeRe(a.alias)}(?![A-Za-z0-9])`, a.alias.length <= 3 ? "" : "i") }));
  const index = new Map<string, { entityId: string; type: string | null }[]>();
  for (const i of instruments) {
    const own = findIdentifiers(i.canonical_name).find((f) => f.kind === "instrument");
    if (own) index.set(own.key, [...(index.get(own.key) ?? []), { entityId: i.entity_id, type: own.type }]);
  }
  return { names, instruments: index };
}

/** Every entity the text names, once each (the first mention), by identifier then by alias. Pure. */
export function resolveText(text: string, r: Resolver): Match[] {
  const out = new Map<string, Match>();
  for (const f of findIdentifiers(text)) {
    if (f.kind !== "instrument") continue;
    for (const hit of r.instruments.get(f.key) ?? []) if (sameIdentifier(f, { key: f.key, type: hit.type }) && !out.has(hit.entityId)) out.set(hit.entityId, { entityId: hit.entityId, how: "identifier", span: [f.start, f.end] });
  }
  for (const n of r.names) {
    const m = n.re.exec(text);
    if (m && !out.has(n.entityId)) out.set(n.entityId, { entityId: n.entityId, how: "alias", span: [m.index, m.index + m[0].length] });
  }
  return [...out.values()];
}
