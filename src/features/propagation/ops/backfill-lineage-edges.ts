// Ported from old_repo/scripts/entities/backfill-lineage-edges.mjs (lines 35-189)
// Feed the typed-lineage capability over the corpus: for every non-archived item, scan its brief and sections, plan typed edges and surface flags, and
// write through the one link step (INV-206 partition: a manual or foreign-origin row is skipped, a tombstoned pair is never re-created). The prior edge
// state is snapshotted (count + md5) before any write and returned. A runtime function: dry flag, no CLI, every read throws on error.
import { createHash } from "node:crypto";

import type { Db } from "@/core/db";
import { linkItems, readLinkCorpus } from "@/core/entities/link-items";
import type { RunResult } from "@/core/sources/run-result";
import { readAdoptedVocabulary } from "@/core/vocabulary/adopted";

import { readTable } from "./read";

export interface EdgeSnapshot {
  count: number;
  md5: string;
}
export function snapshotEdgeState(rows: readonly { source_item_id: string; target_item_id: string; origin: string | null; relationship: string }[]): EdgeSnapshot {
  const lines = rows.map((r) => `${r.source_item_id}|${r.target_item_id}|${r.origin}|${r.relationship}`).sort();
  return { count: lines.length, md5: createHash("md5").update(lines.join("\n")).digest("hex") };
}

export async function backfillLineageEdges(deps: { sb: Db; now: () => Date }, input: { dry: boolean; itemId?: string; limit?: number }): Promise<RunResult<{ snapshot: EdgeSnapshot }>> {
  const { sb } = deps;
  const corpus = await readLinkCorpus(sb);
  const briefs = new Map((await readTable<{ id: string; full_brief: string | null }>(sb, "intelligence_items", "id,full_brief", "id", { eq: ["is_archived", false] })).map((r) => [r.id, r.full_brief ?? ""]));
  const sections = new Map<string, { section_order: number; content_md: string | null }[]>();
  for (const r of await readTable<{ item_id: string; section_order: number; content_md: string | null }>(sb, "intelligence_item_sections", "item_id,section_order,content_md", "item_id")) {
    const list = sections.get(r.item_id) ?? [];
    list.push(r);
    sections.set(r.item_id, list);
  }
  const edges = await readTable<{ source_item_id: string; target_item_id: string; origin: string | null; relationship: string }>(sb, "item_cross_references", "source_item_id,target_item_id,origin,relationship", "id");
  const snapshot = snapshotEdgeState(edges);
  const adoptedRead = await readAdoptedVocabulary(sb);
  const notes: string[] = adoptedRead.note ? [adoptedRead.note] : [];
  let targets = input.itemId ? corpus.filter((c) => c.id === input.itemId) : corpus;
  if (input.limit) targets = targets.slice(0, input.limit);
  const counts: Record<string, number> = { scanned: 0, short: 0, inserted: 0, upgraded: 0, skipped_foreign: 0, conflicts: 0, unchanged: 0, skipped_tombstoned: 0, flags: 0, failed: 0, prior_edges: snapshot.count };
  const add = (k: string, n: number): void => {
    counts[k] = (counts[k] ?? 0) + n;
  };
  for (const item of targets) {
    add("scanned", 1);
    const body = (sections.get(item.id) ?? []).sort((a, b) => a.section_order - b.section_order).map((s) => s.content_md ?? "").join(" ");
    const content = `${briefs.get(item.id) ?? ""} ${body}`.trim();
    if (content.length < 20) {
      add("short", 1);
      continue;
    }
    const r = await linkItems(sb, item.id, { dry: input.dry, content, corpus, adopted: adoptedRead.adopted });
    add("inserted", r.inserted);
    add("upgraded", r.upgraded);
    add("skipped_foreign", r.skippedForeign);
    add("conflicts", r.conflicts);
    add("unchanged", r.unchanged);
    add("skipped_tombstoned", r.skippedTombstoned);
    add("flags", r.surfaced);
    add("failed", r.failed);
    notes.push(...r.notes);
  }
  notes.push(`prior state: ${snapshot.count} item_cross_references rows, md5=${snapshot.md5}`);
  const failed = counts.failed ?? 0;
  return { counts, outcome: failed === 0 ? "ok" : (counts.inserted ?? 0) + (counts.upgraded ?? 0) > 0 ? "partial" : "failed", notes: input.dry ? [...notes, "dry: nothing written"] : notes, data: { snapshot } };
}
