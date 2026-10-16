// Ported from old_repo/src/lib/entities/link-item-entities.mjs (lines 1-62)
// The mint-time spine link: an item gets its jurisdiction entities and refs, its instrument entity and the instrument_entity_id foreign key at
// birth. Every read and write is checked (a failure throws; the caller records it as a flywheel defect), and the existence reads are
// bounded to the ids this item needs, not every entity in the table (B-0057).
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";

import { planInstrument, planInstrumentFkUpdates, planJurisdiction, planJurisdictionRefs } from "./plan";

const ASSERTED_BY = "core/entities/link-entities";

export interface LinkableItem {
  id: string;
  jurisdiction_iso?: string[] | null;
  canonical_instrument_key?: string | null;
}

/** Link one item to the spine. Idempotent: ref and identifier writes ignore duplicates. Returns what was newly linked. */
export async function linkItemEntities(sb: Db, item: LinkableItem, opts: { now: Date }): Promise<{ refs: number; instrumentEntityId: string | null }> {
  const codes = [...new Set((item.jurisdiction_iso ?? []).map((c) => String(c ?? "").trim().toUpperCase()).filter(Boolean))];
  const keys = item.canonical_instrument_key ? [item.canonical_instrument_key] : [];
  if (!codes.length && !keys.length) return { refs: 0, instrumentEntityId: null };

  const wantedIds = new Set<string>();
  const jurSeed = planJurisdiction(codes, { assertedBy: ASSERTED_BY, now: opts.now });
  const insSeed = planInstrument(keys, { assertedBy: ASSERTED_BY, now: opts.now });
  for (const e of [...jurSeed.entities, ...insSeed.entities]) wantedIds.add(e.entity_id);

  const existing = await fetchAllByIdChunks<{ entity_id: string }>([...wantedIds], async (slice) => {
    const { data, error } = await sb.from("entities").select("entity_id").in("entity_id", slice);
    if (error) throw new Error(`link-entities: entities read failed: ${error.message}`);
    return data ?? [];
  });
  const existingEntityIds = new Set(existing.map((e) => e.entity_id));
  const refRes = await sb.from("entity_refs").select("entity_id,ref_id,role").eq("ref_table", "intelligence_items").eq("ref_id", item.id);
  if (refRes.error) throw new Error(`link-entities: entity_refs read failed: ${refRes.error.message}`);
  const existingRefKeys = new Set((refRes.data ?? []).map((r: { entity_id: string; role: string }) => `intelligence_items|${item.id}|${r.entity_id}|${r.role}`));

  const jur = planJurisdiction(codes, { existingEntityIds, assertedBy: ASSERTED_BY, now: opts.now });
  const jurRefs = planJurisdictionRefs("intelligence_items", [item], jur.byCode, existingRefKeys, ASSERTED_BY);
  const ins = planInstrument(keys, { existingEntityIds, assertedBy: ASSERTED_BY, now: opts.now });
  const fk = planInstrumentFkUpdates([item], ins.byKey);

  const write = async (table: string, rows: unknown[], onConflict: string) => {
    if (!rows.length) return;
    const { error } = await sb.from(table).upsert(rows, { onConflict, ignoreDuplicates: true });
    if (error) throw new Error(`link-entities: ${table} write failed: ${error.message}`);
  };
  await write("entities", [...jur.entities, ...ins.entities], "entity_id");
  await write("entity_identifiers", [...jur.identifiers, ...ins.identifiers], "entity_id,scheme,value");
  await write("entity_refs", jurRefs, "ref_table,ref_id,entity_id,role");

  const instrumentEntityId = fk[0]?.instrument_entity_id ?? null;
  if (instrumentEntityId) {
    const { error } = await sb.from("intelligence_items").update({ instrument_entity_id: instrumentEntityId }).eq("id", item.id);
    if (error) throw new Error(`link-entities: instrument_entity_id update failed: ${error.message}`);
  }
  return { refs: jurRefs.length, instrumentEntityId };
}
