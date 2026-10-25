// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the coupling vocabulary as validated data. couplings.json holds every coupling the operator named (feedstocks, energy carriers, infrastructure nodes, modal-shift corridors, consignment-wide mandates,
// quantitative attributes with their units, time windows, the modes and hubs they connect) each with the published page and verbatim quote it is taken from, and the column-to-entity mapping the typed tables are mined through. Nothing here is a number the
// store should hold: the entity ids are stored (the browser-safe detectors cannot hash; a test holds them equal to entityId()); a window is a horizon definition, an attribute carries the unit it is measured in, and no price, rate or factor appears. Logic is in seed.ts, resolve.ts and refs.ts; this file only validates, indexes and answers.
import { z } from "zod";

import type { EntityKind } from "@/core/entities/kinds";

import couplingsJson from "./data/couplings.json";

export const RELATIONS = ["feedstock_of", "fuel_for_mode", "competes_for_feedstock", "shares_grid_zone", "serves_hub", "corridor_links", "implements", "amends", "consignment_wide"] as const;
export type Relation = (typeof RELATIONS)[number];

const schemaText = z.string().min(1);
const schemaCitation = z.object({ url: z.url(), title: schemaText, retrieved_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), quote: schemaText }).strict();
const schemaClass = z.object({ kind: z.enum(["material", "node", "asset", "instrument", "method"]), role: schemaText, rank: z.number().int().min(0), text: z.boolean().optional() }).strict();
const schemaEntity = z
  .object({ key: schemaText, class: schemaText, name: schemaText, aliases: z.array(schemaText), modes: z.array(schemaText).optional(), scenarios: z.array(schemaText).optional(), modeAgnostic: z.boolean().optional(), entityId: z.string().regex(/^cl:[a-z_]+:[0-9a-f]{16}$/), unit: schemaText.optional(), fromMonths: z.number().int().optional(), toMonths: z.number().int().optional(), citation: schemaCitation.optional() })
  .strict();
const schemaRelation = z.object({ parent: schemaText, child: schemaText, relation: z.enum(RELATIONS), citations: z.array(schemaCitation).min(1) }).strict();
const schemaMap = z.object({ column: schemaText.optional(), by: z.enum(["entity", "alias", "mode", "map", "const", "refs"]), map: z.record(z.string(), z.string()).optional(), entity: schemaText.optional(), refTable: schemaText.optional() }).strict();
const schemaColumn = z.object({ table: schemaText, pk: schemaText, maps: z.array(schemaMap).min(1) }).strict();

export type CouplingEntity = z.infer<typeof schemaEntity>;
export type ColumnMap = z.infer<typeof schemaColumn>;
export interface Coupling extends CouplingEntity {
  /** Whether the entity is named in text (its name and aliases resolve); a mode, a hub or a window is filed by column and relation only. */
  named: boolean;
  kind: EntityKind;
  role: string;
}

const couplingFile = z.object({ version: schemaText, classes: z.record(z.string(), schemaClass), entities: z.array(schemaEntity), relations: z.array(schemaRelation), columns: z.array(schemaColumn) }).strict().parse(couplingsJson);
const entityByKey = new Map(couplingFile.entities.map((e) => [e.key, e]));
const fileProblems: string[] = [];
if (entityByKey.size !== couplingFile.entities.length) fileProblems.push("an entity key is repeated");
for (const e of couplingFile.entities) {
  if (!couplingFile.classes[e.class]) fileProblems.push(`${e.key}: class ${e.class} is not defined`);
  if (e.class !== "window" && !e.citation) fileProblems.push(`${e.key}: a coupling other than a time window carries the page and quote it is taken from`);
}
for (const r of couplingFile.relations) {
  const [p, c] = [entityByKey.get(r.parent), entityByKey.get(r.child)];
  if (!p || !c) fileProblems.push(`${r.parent} ${r.relation} ${r.child}: an end is not an entity`);
  else if ((couplingFile.classes[c.class]?.rank ?? 0) < (couplingFile.classes[p.class]?.rank ?? 0)) fileProblems.push(`${r.parent} ${r.relation} ${r.child}: a relation runs from a lower rank to a higher one, so the table can hold no cycle`);
}
for (const k of couplingFile.columns.flatMap((c) => c.maps.flatMap((m) => [m.entity, ...Object.values(m.map ?? {})]))) if (k && !entityByKey.has(k)) fileProblems.push(`column map names ${k}, which is not an entity`);
if (fileProblems.length) throw new Error(`couplings.json: ${fileProblems.join("; ")}`);

export const COUPLING_VERSION = couplingFile.version;
export const COUPLINGS: readonly Coupling[] = couplingFile.entities.map((e) => {
  const c = couplingFile.classes[e.class] as z.infer<typeof schemaClass>;
  return { ...e, kind: c.kind, role: c.role, named: c.text !== false };
});
export const COLUMNS: readonly ColumnMap[] = couplingFile.columns;
export const COUPLING_RELATIONS = couplingFile.relations;
const couplingsByKey = new Map(COUPLINGS.map((c) => [c.key, c]));
const couplingsById = new Map(COUPLINGS.map((c) => [c.entityId, c]));
export const couplingByKey = (key: string): Coupling | undefined => couplingsByKey.get(key);
export const couplingById = (id: string): Coupling | undefined => couplingsById.get(id);
/** The ref role of an entity: its coupling class's, else cites_<kind> for a spine entity (jurisdiction, organisation, instrument, corridor) outside the vocabulary. */
export const roleOf = (entityIdValue: string): string => couplingById(entityIdValue)?.role ?? `cites_${/^cl:([a-z_]+):/.exec(entityIdValue)?.[1] ?? "entity"}`;
/** The windows in months, in order: the horizons a pattern is read over. */
export const WINDOWS = COUPLINGS.filter((c) => c.class === "window").map((c) => ({ name: c.name, fromMonths: c.fromMonths ?? 0, toMonths: c.toMonths ?? 0 }));
/** The couplings whose scenario list names the tag. */
export const couplingsForScenario = (tag: string): Coupling[] => COUPLINGS.filter((c) => c.scenarios?.some((s) => s.toLowerCase() === tag.toLowerCase()));
