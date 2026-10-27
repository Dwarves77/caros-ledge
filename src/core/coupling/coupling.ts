// The coupling configuration as validated data (ADR-053, NO-ENTITY-LISTS-1, operator 2026-10-26): couplings.json holds NO entity, name or alias. The ontology is the database (entities, entity_identifiers, entity_relations, entity_refs; see ontology.ts); this file holds only the non-word
// configuration: the entity classes (kind, ref role, rank), the horizon windows, and the column-to-entity mapping the typed tables are mined through (an entity id held in a column, a closed transport-mode token, or the refs another table's row already holds).
// Logic is in ontology.ts, resolve.ts and refs.ts; this file only validates, indexes and answers.
import { z } from "zod";

import type { EntityKind } from "@/core/entities/kinds";

import couplingsJson from "./data/couplings.json";

export const RELATIONS = ["feedstock_of", "fuel_for_mode", "competes_for_feedstock", "shares_grid_zone", "serves_hub", "corridor_links", "implements", "amends", "consignment_wide"] as const;
export type Relation = (typeof RELATIONS)[number];

const schemaText = z.string().min(1);
const schemaClass = z.object({ kind: z.enum(["material", "node", "asset", "instrument", "method"]), role: schemaText, rank: z.number().int().min(0), text: z.boolean().optional() }).strict();
const schemaWindow = z.object({ name: schemaText, fromMonths: z.number().int(), toMonths: z.number().int() }).strict();
// `entity`: a column that holds an entity id; `mode`: a column that holds a closed transport-mode token (resolved to the mode entity the live refs already name); `refs`: copy the refs another table's row holds (a foreign key to it). No map from words to entities exists.
const schemaMap = z.object({ column: schemaText, by: z.enum(["entity", "mode", "refs"]), refTable: schemaText.optional() }).strict();
const schemaColumn = z.object({ table: schemaText, pk: schemaText, maps: z.array(schemaMap).min(1) }).strict();

export type ColumnMap = z.infer<typeof schemaColumn>;
export interface ClassSpec {
  kind: EntityKind;
  role: string;
  rank: number;
}

const couplingFile = z.object({ version: schemaText, classes: z.record(z.string(), schemaClass), windows: z.array(schemaWindow), columns: z.array(schemaColumn) }).strict().parse(couplingsJson);
const problems: string[] = [];
for (const c of couplingFile.columns) for (const m of c.maps) if (m.by === "refs" && !m.refTable) problems.push(`${c.table}.${m.column}: a refs map names the table it copies from`);
if (problems.length) throw new Error(`couplings.json: ${problems.join("; ")}`);

export const CLASSES: Readonly<Record<string, ClassSpec>> = Object.fromEntries(Object.entries(couplingFile.classes).map(([k, c]) => [k, { kind: c.kind, role: c.role, rank: c.rank }]));
export const COLUMNS: readonly ColumnMap[] = couplingFile.columns;
/** The windows in months, in order: the horizons a pattern is read over. */
export const WINDOWS = couplingFile.windows;
