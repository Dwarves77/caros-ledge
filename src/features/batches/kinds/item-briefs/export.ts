// Ported from old_repo/scripts/turns/export-corpus-for-extraction.mjs (lines 88-130)
// Ported from old_repo/scripts/turns/export-corpus-for-extraction.mjs (lines 180-292)
// Ported from old_repo/scripts/turns/export-corpus-for-extraction.mjs (lines 392-533)
// Item briefs (DIGEST-1 D1): the item's own export plus what its relationship sections are written from: obligation objects, scores, the sources its claims cite with their tiers and bias tags, and the pattern packets of every derived pattern
// the item is a member of (read through the packets door; the summary states what is absent). The brief-authoring export: record-grade stub items with the pool text a session may cite (and ONLY that text), the pool hash the entry must echo (INV-207), the required slots with their descriptions (a slot's
// description says whether a GAP may cover it), the forward events and timelines the brief must carry, and the claims and sections already held. The default scope is verified live items still at record grade (the catalogue stub; writing a brief upgrades the grade); an
// explicit `ids` list reaches a quarantined item too (ADR-030: items are resolved, never left quarantined), and an id that cannot be exported is named with its reason.
import type { Db } from "@/core/db";
import { specForItemType } from "@/core/brief";
import { DUTY_HOLDER_CLASSES } from "@/core/contracts/vocabularies";
import { allRows, rowsByIds } from "@/core/db";
import { digestKind, guideSkills } from "@/core/digest/kinds";
import { packetReader, type Packet, type PacketReader } from "@/core/digest/packets-client";
import { secondReaderBlock } from "@/core/digest/review";
import { readExtractionInput } from "@/features/obligations";

import { itemPool, type BatchExport, type Obj } from "../../kit/session-batch";

import { candidateMenu, itemSeed, menuBlock } from "./candidates";

const omitId = (row: Obj): Obj => Object.fromEntries(Object.entries(row).filter(([k]) => k !== "id"));
interface ItemRow { id: string; title: string | null; item_type: string; format_type: string | null; jurisdiction_iso: string[] | null; canonical_instrument_key: string | null; source_id: string | null; source_url: string | null; provenance_status: string | null; is_archived: boolean | null; priority: string | null; severity: string | null; urgency_tier: string | null; instrument_entity_id: string | null }
const COLUMNS = "id, title, item_type, format_type, jurisdiction_iso, canonical_instrument_key, source_id, source_url, provenance_status, is_archived, priority, severity, urgency_tier, instrument_entity_id";

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

/** The obligations, scores and source tiers with bias tags the item's claims rest on: each a bounded read by the item's own key; a failed read throws. */
async function itemContext(sb: Db, it: ItemRow): Promise<{ context: Obj; claimIds: string[]; obligationIds: string[] }> {
  const obligations = await allRows<Obj>(sb, "obligation_objects", "obligation_id, pinpoint_citation, verbatim_text, binding_position, duty_holder_class, applicability_trigger, first_deadline, enforcement_start, sanction_class, statutory_maximum, cost_formula, direct_compliance_cost, status", { order: "obligation_id", where: (q) => q.eq("instrument_item_id", it.id) });
  const impact = await allRows<Obj>(sb, "item_impact_scores", "cost, compliance, operational, basis, missing, method_version", { order: "item_id", where: (q) => q.eq("item_id", it.id) });
  const cited = await allRows<{ id: string; source_id: string | null }>(sb, "section_claim_provenance", "id, source_id", { where: (q) => q.eq("intelligence_item_id", it.id) });
  const sourceIds = [...new Set([it.source_id, ...cited.map((c) => c.source_id)].filter((s): s is string => !!s))];
  const sources = await rowsByIds<Obj>(sb, "sources", "id, name, base_tier, effective_tier, source_role", sourceIds);
  const bias = await rowsByIds<Obj & { source_id: string }>(sb, "source_bias_tags", "id, source_id, dimension, tag, confidence", sourceIds, "source_id", "id");
  const context = { obligation_objects: obligations, scores: { priority: it.priority, severity: it.severity, urgency_tier: it.urgency_tier, impact: impact[0] ?? null }, sources: sources.map((s) => ({ ...s, bias_tags: bias.filter((b) => b.source_id === s.id).map((b) => ({ dimension: b.dimension, tag: b.tag, confidence: b.confidence })) })) };
  return { context, claimIds: cited.map((c) => c.id), obligationIds: obligations.map((o) => String(o.obligation_id)) };
}

export function itemBriefsExporter(sb: Db, now: () => Date, packets: PacketReader = packetReader(sb)) {
  return async (o: { limit: number; ids?: readonly string[] }): Promise<BatchExport> => {
    try {
      const sel = o.ids?.length ? await selectByIds(sb, o.ids) : await selectNextStubs(sb, o.limit);
      const items = sel.items;
      const slotRows = await allRows<{ item_type: string; slot_key: string; description: string | null }>(sb, "item_type_required_slots", "item_type, slot_key, description", { cap: 5000 });
      const guide = digestKind("item-briefs");
      if (!guide) throw new Error("the item-briefs kind is not in the registry");
      const packetRead = await packets(items.map((i) => i.id));
      const packetsOf = (id: string): Packet[] => packetRead.packets.filter((p) => p.id === id || p.members.some((m) => m.table === "intelligence_items" && m.id === id));
      const out: Obj[] = [];
      for (const it of items) {
        const [input, pool] = [await readExtractionInput(sb, it.id, now()), await itemPool(sb, it.id)];
        const events = await allRows<Obj>(sb, "item_forward_events", "id, event_date, event_kind, obligation_text, confidence, source_span", { where: (q) => q.eq("intelligence_item_id", it.id) });
        const ctx = await itemContext(sb, it);
        const menu = await candidateMenu(sb, await itemSeed(sb, it, { claimIds: ctx.claimIds, eventIds: events.map((e) => String(e.id)), obligationIds: ctx.obligationIds }));
        const timelines = await allRows<Obj>(sb, "item_timelines", "id, milestone_date, label, is_completed", { where: (q) => q.eq("item_id", it.id) });
        out.push({
          id: it.id, provenance_status: it.provenance_status, title: it.title, item_type: it.item_type, format_type: it.format_type, jurisdiction_iso: it.jurisdiction_iso, canonical_instrument_key: it.canonical_instrument_key, source_id: it.source_id, source_url: it.source_url,
          required_slots: slotRows.filter((s) => s.item_type === it.item_type).map((s) => ({ slot_key: s.slot_key, description: s.description })),
          claims: input.claims, sections: input.sections, pool: pool.pool.map(({ id, url, text }) => ({ capture_id: id, url, text })), source_pool_hash: pool.hash, candidate_entities: menuBlock(menu),
          forward_events: events.map((e) => omitId(e)), timelines: timelines.map((t) => omitId(t)),
          authoring_skills: guideSkills(guide, specForItemType(it.item_type)?.formatType), ...ctx.context, packets: packetsOf(it.id),
        });
      }
      return { ok: true, items: out, source: { type: "table", table: "intelligence_items" }, summary: { second_reader: secondReaderBlock("item-briefs"), items_exported: out.length, not_exported: sel.notExported.length, packets: packetRead.marker ?? "read", workspace_role_vocabulary: Object.values(DUTY_HOLDER_CLASSES).map((c) => ({ code: c.code, label: c.label, org_roles: c.orgRoles ?? [] })) }, residue: sel.notExported };
    } catch (e) {
      return { ok: false, items: [], error: (e as Error).message };
    }
  };
}
