// Ported from old_repo/scripts/turns/export-corpus-for-extraction.mjs (lines 88-130)
// Ported from old_repo/scripts/turns/export-corpus-for-extraction.mjs (lines 180-292)
// Ported from old_repo/scripts/turns/export-corpus-for-extraction.mjs (lines 392-533)
// The brief-authoring export: record-grade stub items with the pool text a session may cite (and ONLY that text), the pool hash the entry must echo (INV-207), the required slots with their descriptions (a slot's
// description says whether a GAP may cover it), the forward events and timelines the brief must carry, and the claims and sections already held. The default scope is verified live items still at record grade (the catalogue stub; writing a brief upgrades the grade); an
// explicit `ids` list reaches a quarantined item too (ADR-030: items are resolved, never left quarantined), and an id that cannot be exported is named with its reason.
import type { Db } from "@/core/db";
import { readExtractionInput } from "@/features/obligations";
import { allRows, rowsByIds } from "@/core/db";

import { itemPool, type BatchExport, type Obj } from "../../kit/session-batch";

export const RECORD_EXPORT_LIMIT = 40;
const omitId = (row: Obj): Obj => Object.fromEntries(Object.entries(row).filter(([k]) => k !== "id"));
interface ItemRow { id: string; title: string | null; item_type: string; format_type: string | null; jurisdiction_iso: string[] | null; canonical_instrument_key: string | null; source_id: string | null; source_url: string | null; provenance_status: string | null; is_archived: boolean | null }
const COLUMNS = "id, title, item_type, format_type, jurisdiction_iso, canonical_instrument_key, source_id, source_url, provenance_status, is_archived";

/** The exact ids requested, as items: verified or quarantined and not archived; every id that cannot be exported is named archived or not_found. */
async function selectByIds(sb: Db, ids: readonly string[]): Promise<{ items: ItemRow[]; notExported: { id: string; reason: "archived" | "not_found" }[] }> {
  const found = await rowsByIds<ItemRow>(sb, "intelligence_items", COLUMNS, ids);
  const items = found.filter((r) => !r.is_archived && (r.provenance_status === "verified" || r.provenance_status === "quarantined"));
  const have = new Set(items.map((r) => r.id));
  const archived = new Set(found.filter((r) => r.is_archived).map((r) => r.id));
  return { items, notExported: ids.filter((id) => !have.has(id)).map((id) => ({ id, reason: archived.has(id) ? "archived" as const : "not_found" as const })) };
}

/** The next verified live items still at record grade, in id order: one bounded read. */
async function selectNextStubs(sb: Db, limit: number): Promise<{ items: ItemRow[]; notExported: [] }> {
  const { data, error } = await sb.from("intelligence_items").select(COLUMNS).eq("item_grade", "record").eq("provenance_status", "verified").eq("is_archived", false).order("id", { ascending: true }).limit(limit);
  if (error) throw new Error(`intelligence_items read failed: ${error.message}`);
  return { items: (data ?? []) as ItemRow[], notExported: [] };
}

export function recordBriefsExporter(sb: Db, now: () => Date) {
  return async (o: { limit: number; ids?: readonly string[] }): Promise<BatchExport> => {
    try {
      const sel = o.ids?.length ? await selectByIds(sb, o.ids) : await selectNextStubs(sb, o.limit);
      const items = sel.items;
      const slotRows = await allRows<{ item_type: string; slot_key: string; description: string | null }>(sb, "item_type_required_slots", "item_type, slot_key, description", { cap: 5000 });
      const out: Obj[] = [];
      for (const it of items) {
        const [input, pool] = [await readExtractionInput(sb, it.id, now()), await itemPool(sb, it.id)];
        const events = await allRows<Obj>(sb, "item_forward_events", "id, event_date, event_kind, obligation_text, confidence, source_span", { where: (q) => q.eq("intelligence_item_id", it.id) });
        const timelines = await allRows<Obj>(sb, "item_timelines", "id, milestone_date, label, is_completed", { where: (q) => q.eq("item_id", it.id) });
        out.push({
          id: it.id, provenance_status: it.provenance_status, title: it.title, item_type: it.item_type, format_type: it.format_type, jurisdiction_iso: it.jurisdiction_iso, canonical_instrument_key: it.canonical_instrument_key, source_id: it.source_id, source_url: it.source_url,
          required_slots: slotRows.filter((s) => s.item_type === it.item_type).map((s) => ({ slot_key: s.slot_key, description: s.description })),
          claims: input.claims, sections: input.sections, pool: pool.pool, source_pool_hash: pool.hash,
          forward_events: events.map((e) => omitId(e)), timelines: timelines.map((t) => omitId(t)),
        });
      }
      return { ok: true, items: out, source: { type: "table", table: "intelligence_items" }, summary: { items_exported: out.length, not_exported: sel.notExported.length }, residue: sel.notExported };
    } catch (e) {
      return { ok: false, items: [], error: (e as Error).message };
    }
  };
}
