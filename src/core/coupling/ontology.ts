// The ontology is the database (ADR-053, NO-ENTITY-LISTS-1): the entity spine (entities, entity_relations) and the refs already filed (entity_refs) say what each entity is. No name, alias or entity id is typed in code or in couplings.json.
//   class   of an entity: the class its refs are filed under most (the role `cites_<class>` of entity_refs), else its kind;
//   mode    tokens of an entity: a mode entity's tokens are the closed transport-mode values its typed-column refs were filed from (basis.value of a cites_mode ref); any other entity carries the tokens of the mode entities one relation away;
//   modeEntity(token): the entity the live refs file a closed mode token under (none until a row of that mode has been filed).
// Pure over rows (ontologyOf); loadOntology reads the three tables.
import { normaliseMode } from "@/core/contracts/vocabularies";
import type { Db } from "@/core/db";

import { CLASSES } from "./coupling";
import { readAll } from "./read";

export interface Ontology {
  /** The class of an entity ("mode", "hub", "carrier", "jurisdiction", ...), "" when nothing is known of it. */
  classOf(entityId: string): string;
  /** The transport modes (canonical tokens) the entity is or couples. */
  modesOf(entityId: string): string[];
  /** The ref role an entity is filed under. */
  roleOf(entityId: string): string;
  /** The mode entity a closed mode token is filed under. */
  modeEntity(token: string): string | undefined;
}

const kindOfId = (id: string): string => /^cl:([a-z_]+):/.exec(id)?.[1] ?? "";
const WINDOW_TOKEN = /^\d+-\d+m$/;
const classOfRole = (role: string): string => (role.startsWith("cites_") ? role.slice(6) : "");

export interface OntologyRows {
  entities: readonly { entity_id: string; kind: string; canonical_name?: string }[];
  refs: readonly { entity_id: string; role: string; basis: { column?: unknown; value?: unknown } | null }[];
  relations: readonly { parent_entity_id: string; child_entity_id: string }[];
}

export function ontologyOf(rows: OntologyRows): Ontology {
  const roleCounts = new Map<string, Map<string, number>>();
  const tokens = new Map<string, Set<string>>();
  const byToken = new Map<string, string>();
  for (const r of rows.refs) {
    const m = roleCounts.get(r.entity_id) ?? new Map<string, number>();
    m.set(r.role, (m.get(r.role) ?? 0) + 1);
    roleCounts.set(r.entity_id, m);
    // the basis value is the token the column held: a string, or (a text[] mode column) a one-element array; a multi-mode array names none, since which of them the entity is cannot be read from the row
    const held = Array.isArray(r.basis?.value) && r.basis.value.length === 1 ? r.basis.value[0] : r.basis?.value;
    if (r.role === "cites_mode" && r.basis?.column === "mode" && typeof held === "string") {
      const t = normaliseMode(held);
      if (t) {
        tokens.set(r.entity_id, new Set([...(tokens.get(r.entity_id) ?? []), t]));
        if (!byToken.has(t)) byToken.set(t, r.entity_id);
      }
    }
  }
  const kind = new Map(rows.entities.map((e) => [e.entity_id, e.kind]));
  // a horizon window is a formal token (`0-6m`), not a word: an entity whose name has that shape and that no ref names by a class is a window
  const window = new Set(rows.entities.filter((e) => e.canonical_name !== undefined && WINDOW_TOKEN.test(e.canonical_name)).map((e) => e.entity_id));
  const classOf = (id: string): string => {
    const roles = [...(roleCounts.get(id) ?? [])].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const named = roles.map(([r]) => classOfRole(r)).find((c) => c && c !== "instrument" && c !== "jurisdiction" && c !== "organisation");
    return named || classOfRole(roles[0]?.[0] ?? "") || (window.has(id) ? "window" : "") || kind.get(id) || kindOfId(id);
  };
  const near = new Map<string, string[]>();
  for (const l of rows.relations) {
    near.set(l.parent_entity_id, [...(near.get(l.parent_entity_id) ?? []), l.child_entity_id]);
    near.set(l.child_entity_id, [...(near.get(l.child_entity_id) ?? []), l.parent_entity_id]);
  }
  const classMemo = new Map<string, string>();
  const cls = (id: string): string => {
    const hit = classMemo.get(id);
    if (hit !== undefined) return hit;
    const c = classOf(id);
    classMemo.set(id, c);
    return c;
  };
  const modesOf = (id: string): string[] => {
    const own = tokens.get(id);
    if (own) return [...own].sort();
    return [...new Set((near.get(id) ?? []).flatMap((n) => [...(tokens.get(n) ?? [])]))].sort();
  };
  return { classOf: cls, modesOf, roleOf: (id) => CLASSES[cls(id)]?.role ?? `cites_${cls(id) || "entity"}`, modeEntity: (t) => byToken.get(normaliseMode(t) ?? t) };
}

/** The ontology as the database holds it now (three paged reads). */
export async function loadOntology(sb: Db): Promise<Ontology> {
  const [entities, refs, relations] = await Promise.all([
    readAll<{ entity_id: string; kind: string; canonical_name: string }>(sb, "entities", "entity_id,kind,canonical_name", ["entity_id"]),
    readAll<{ entity_id: string; role: string; basis: { column?: unknown; value?: unknown } | null }>(sb, "entity_refs", "entity_id,role,basis", ["ref_table", "ref_id", "entity_id", "role"]),
    readAll<{ parent_entity_id: string; child_entity_id: string }>(sb, "entity_relations", "parent_entity_id,child_entity_id", ["parent_entity_id", "child_entity_id", "relation"]),
  ]);
  return ontologyOf({ entities, refs, relations });
}
