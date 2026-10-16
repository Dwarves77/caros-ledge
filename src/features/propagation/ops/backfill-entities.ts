// Ported from old_repo/scripts/entities/backfill-entities.mjs (lines 26-224)
// Populate the entity spine from what the corpus already holds: jurisdiction entities and refs (intelligence_items.jurisdiction_iso, regions.iso_codes),
// instrument entities and the item foreign key (canonical_instrument_key), organisation entities and the source foreign key (sources.url host).
// The planners are core/entities/plan; this is the reads and the writes. A runtime function: dry flag, no CLI, every read throws on error.
import type { Db } from "@/core/db";
import { distinctNormalized, planInstrument, planInstrumentFkUpdates, planJurisdiction, planJurisdictionRefs, planOrganisation, planOrganisationFkUpdates, type PlanOpts } from "@/core/entities/plan";
import type { RunResult } from "@/core/sources/run-result";

import { readTable } from "./read";

export const BACKFILL_KINDS = ["jurisdiction", "instrument", "organisation"] as const;
export type BackfillKind = (typeof BACKFILL_KINDS)[number];
const ASSERTED_BY = "ops/backfill-entities";

interface Ctx {
  sb: Db;
  dry: boolean;
  opts: PlanOpts;
  counts: Record<string, number>;
  notes: string[];
  limit: number | undefined;
}
const cap = <T>(rows: T[], limit: number | undefined): T[] => (limit ? rows.slice(0, limit) : rows);
const bump = (c: Ctx, k: string, n = 1): void => {
  c.counts[k] = (c.counts[k] ?? 0) + n;
};
async function insertMany(c: Ctx, table: string, rows: unknown[], key: string): Promise<void> {
  if (!rows.length || c.dry) return;
  const { error } = await c.sb.from(table).insert(rows);
  if (error) {
    bump(c, "failed", rows.length);
    c.notes.push(`${table} insert failed: ${error.message}`);
  } else bump(c, key, rows.length);
}
async function updateEach(c: Ctx, table: string, updates: { id: string; [k: string]: string }[], col: string, key: string): Promise<void> {
  if (c.dry) return;
  for (const u of updates) {
    const { error } = await c.sb.from(table).update({ [col]: u[col] }).eq("id", u.id);
    if (error) {
      bump(c, "failed");
      c.notes.push(`${table} ${u.id}: ${error.message}`);
    } else bump(c, key);
  }
}

async function jurisdiction(c: Ctx): Promise<void> {
  const items = cap(await readTable<{ id: string; jurisdiction_iso: string[] | null }>(c.sb, "intelligence_items", "id,jurisdiction_iso", "id"), c.limit);
  const regions = cap(await readTable<{ id: string; iso_codes: string[] | null }>(c.sb, "regions", "id,iso_codes", "id"), c.limit);
  const codes = distinctNormalized([...items.flatMap((r) => r.jurisdiction_iso ?? []), ...regions.flatMap((r) => r.iso_codes ?? [])]);
  const plan = planJurisdiction(codes, { ...c.opts, assertedBy: ASSERTED_BY });
  const have = await readTable<{ ref_table: string; ref_id: string; entity_id: string; role: string }>(c.sb, "entity_refs", "ref_table,ref_id,entity_id,role", "entity_id");
  const haveKeys = new Set(have.map((r) => `${r.ref_table}|${r.ref_id}|${r.entity_id}|${r.role}`));
  const refs = [...planJurisdictionRefs("intelligence_items", items, plan.byCode, haveKeys, ASSERTED_BY), ...planJurisdictionRefs("regions", regions, plan.byCode, haveKeys, ASSERTED_BY)];
  bump(c, "jurisdiction_planned", plan.entities.length);
  bump(c, "jurisdiction_refs_planned", refs.length);
  await insertMany(c, "entities", plan.entities, "entities_created");
  await insertMany(c, "entity_identifiers", plan.identifiers, "identifiers_created");
  await insertMany(c, "entity_refs", refs, "refs_created");
}
async function instrument(c: Ctx): Promise<void> {
  const items = cap(await readTable<{ id: string; canonical_instrument_key: string | null; instrument_entity_id: string | null }>(c.sb, "intelligence_items", "id,canonical_instrument_key,instrument_entity_id", "id", { notNull: "canonical_instrument_key" }), c.limit);
  const plan = planInstrument(distinctNormalized(items.map((r) => r.canonical_instrument_key)), { ...c.opts, assertedBy: ASSERTED_BY });
  const updates = planInstrumentFkUpdates(items.filter((r) => !r.instrument_entity_id), plan.byKey);
  bump(c, "instrument_planned", plan.entities.length);
  bump(c, "instrument_fk_planned", updates.length);
  await insertMany(c, "entities", plan.entities, "entities_created");
  await insertMany(c, "entity_identifiers", plan.identifiers, "identifiers_created");
  await updateEach(c, "intelligence_items", updates, "instrument_entity_id", "fk_updated");
}
async function organisation(c: Ctx): Promise<void> {
  const sources = cap(await readTable<{ id: string; url: string | null; organisation_entity_id: string | null }>(c.sb, "sources", "id,url,organisation_entity_id", "id"), c.limit);
  const plan = planOrganisation(sources.map((s) => s.url ?? ""), { ...c.opts, assertedBy: ASSERTED_BY });
  const updates = planOrganisationFkUpdates(sources.filter((s) => !s.organisation_entity_id), plan.byHost);
  bump(c, "organisation_planned", plan.entities.length);
  bump(c, "organisation_fk_planned", updates.length);
  await insertMany(c, "entities", plan.entities, "entities_created");
  await insertMany(c, "entity_identifiers", plan.identifiers, "identifiers_created");
  await updateEach(c, "sources", updates, "organisation_entity_id", "fk_updated");
}

export async function backfillEntities(deps: { sb: Db; now: () => Date }, input: { dry: boolean; kinds?: readonly BackfillKind[]; limit?: number }): Promise<RunResult> {
  const entities = await readTable<{ entity_id: string }>(deps.sb, "entities", "entity_id", "entity_id");
  const identifiers = await readTable<{ entity_id: string; scheme: string; value: string }>(deps.sb, "entity_identifiers", "entity_id,scheme,value", "entity_id");
  const c: Ctx = {
    sb: deps.sb,
    dry: input.dry,
    opts: { existingEntityIds: new Set(entities.map((e) => e.entity_id)), existingIdentifierKeys: new Set(identifiers.map((r) => `${r.entity_id}|${r.scheme}|${r.value}`)), assertedBy: ASSERTED_BY, now: deps.now() },
    counts: { failed: 0, prior_entities: entities.length, prior_identifiers: identifiers.length },
    notes: [],
    limit: input.limit,
  };
  const kinds = new Set(input.kinds ?? BACKFILL_KINDS);
  if (kinds.has("jurisdiction")) await jurisdiction(c);
  if (kinds.has("instrument")) await instrument(c);
  if (kinds.has("organisation")) await organisation(c);
  const failed = c.counts.failed ?? 0;
  const written = (c.counts.entities_created ?? 0) + (c.counts.refs_created ?? 0) + (c.counts.fk_updated ?? 0);
  return { counts: c.counts, outcome: failed === 0 ? "ok" : written > 0 ? "partial" : "failed", notes: input.dry ? [...c.notes, "dry: nothing written"] : c.notes };
}
