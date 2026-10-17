// Ported from old_repo/src/components/admin/corrections/load-item-targets.mjs (lines 5-62)
import { TAG_COLUMNS } from "@/core/corrections/model";
import { allRows, rowsByIds } from "@/core/db";
import type { Db } from "@/core/db";

import type { ItemTargets } from "./types";

/** Everything one item can be corrected on, in one read set: its tags, facts, sections and connections (both edge directions collapsed to one row per other item). Null when the item does not exist; any failed read throws. */
export async function loadItemTargets(db: Db, itemId: string): Promise<ItemTargets | null> {
  const { data: item, error } = await db.from("intelligence_items").select("id, title, full_brief, topic_tags, operational_scenario_tags, compliance_object_tags").eq("id", itemId).maybeSingle();
  if (error) throw new Error(`item read failed: ${error.message}`);
  if (!item) return null;
  const [sections, claims, outgoing, incoming] = await Promise.all([
    allRows<{ id: string; section_key: string; section_order: number | null; content_md: string }>(db, "intelligence_item_sections", "id, section_key, section_order, content_md", { where: (q) => q.eq("item_id", itemId) }),
    allRows<{ id: string; claim_text: string; source_span: string | null }>(db, "section_claim_provenance", "id, claim_text, claim_kind, source_span, section_row_id", { where: (q) => q.eq("intelligence_item_id", itemId).eq("claim_kind", "FACT") }),
    allRows<{ id: string; target_item_id: string; relationship: string }>(db, "item_cross_references", "id, target_item_id, relationship", { where: (q) => q.eq("source_item_id", itemId) }),
    allRows<{ id: string; source_item_id: string; relationship: string }>(db, "item_cross_references", "id, source_item_id, relationship", { where: (q) => q.eq("target_item_id", itemId) }),
  ]);
  const edges = [...outgoing.map((e) => ({ other: e.target_item_id, relationship: e.relationship })), ...incoming.map((e) => ({ other: e.source_item_id, relationship: e.relationship }))];
  const titles = new Map((await rowsByIds<{ id: string; title: string }>(db, "intelligence_items", "id, title", edges.map((e) => e.other))).map((o) => [o.id, o.title]));
  const seen = new Set<string>();
  const connections = edges.filter((e) => !seen.has(e.other) && !!seen.add(e.other)).map((e) => ({ other_item_id: e.other, other_title: titles.get(e.other) ?? "An item that could not be read", relationship: e.relationship }));
  const row = item as unknown as Record<string, unknown>;
  const tags = Object.fromEntries(TAG_COLUMNS.map((c) => [c, Array.isArray(row[c]) ? (row[c] as string[]) : []])) as ItemTargets["tags"];
  return {
    item_id: String(row.id),
    title: typeof row.title === "string" && row.title ? row.title : "Untitled item",
    full_brief: typeof row.full_brief === "string" ? row.full_brief : "",
    tags,
    facts: claims.map((c) => ({ id: c.id, claim_text: c.claim_text, source_span: c.source_span ?? null })),
    sections: [...sections].sort((a, b) => (a.section_order ?? 0) - (b.section_order ?? 0)).map((s) => ({ section_key: s.section_key, content_md: s.content_md })),
    connections,
  };
}
