// Ported from old_repo/src/lib/entities/link-items.ts (lines 46-165)
// The link step: read an item's text, plan its typed lineage edges and entity-mention flags, partition the edges against the live ones (INV-206),
// write edges and flags (the moat boundary: nothing else). Fixes B-0256/B-0057: the corpus is passed in or read once with its error surfaced,
// adopted-term entities are minted by the term pass (not on every call), the open-flag read fails closed, and every write error is counted.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import { readAdoptedVocabulary, type AdoptedVocabulary } from "@/core/vocabulary/adopted";
import { readConnectionCorrectionsFor, tombstonedPairKeys } from "@/core/corrections";

import { partitionLineageWrites, pairKey, type EdgeRowLike } from "./lineage";
import { assertMoatBoundary, planLinkWrites, type CorpusRow } from "./mentions";

export interface LinkResult {
  edges: number;
  surfaced: number;
  skipped: boolean;
  inserted: number;
  upgraded: number;
  skippedForeign: number;
  conflicts: number;
  unchanged: number;
  skippedTombstoned: number;
  typed: number;
  failed: number;
  notes: string[];
  dry: boolean;
}
export interface LinkOptions {
  dry?: boolean;
  /** Text to scan; read from the item's brief and its captures when absent. */
  content?: string;
  /** The resolution corpus (id, title, instrument_identifier); read once when absent. */
  corpus?: CorpusRow[];
  adopted?: Partial<AdoptedVocabulary>;
}
const NOTHING: LinkResult = { edges: 0, surfaced: 0, skipped: true, inserted: 0, upgraded: 0, skippedForeign: 0, conflicts: 0, unchanged: 0, skippedTombstoned: 0, typed: 0, failed: 0, notes: [], dry: false };

/** Every non-archived item as a resolution corpus row, total-ordered. A failed page throws. */
export async function readLinkCorpus(sb: Db): Promise<CorpusRow[]> {
  return fetchAllRows<CorpusRow>((from, to) => sb.from("intelligence_items").select("id,title,instrument_identifier").eq("is_archived", false).order("id", { ascending: true }).range(from, to), { cap: 200_000 });
}

/** Whether an open flag of this producer exists for the item (a failed read throws: the link step never inserts blind). */
async function hasOpenFlag(sb: Db, subjectRef: string, createdBy: string): Promise<boolean> {
  const { data, error } = await sb.from("integrity_flags").select("id").eq("subject_ref", subjectRef).eq("created_by", createdBy).eq("status", "open").limit(1);
  if (error) throw new Error(`integrity_flags open-check failed for ${subjectRef}/${createdBy}: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Link one item's text to the corpus. Never throws on a write: a failure is counted in `failed` and named in `notes` so the caller records it. */
export async function linkItems(sb: Db, itemId: string, opts: LinkOptions = {}): Promise<LinkResult> {
  const dry = opts.dry === true;
  const notes: string[] = [];
  let content = opts.content;
  if (content === undefined) {
    const item = await sb.from("intelligence_items").select("full_brief").eq("id", itemId).single();
    if (item.error) throw new Error(`link-items: item read failed: ${item.error.message}`);
    const pool = await sb.from("agent_run_searches").select("result_content").eq("intelligence_item_id", itemId);
    if (pool.error) throw new Error(`link-items: capture read failed: ${pool.error.message}`);
    content = `${(item.data as { full_brief?: string } | null)?.full_brief ?? ""} ${(pool.data ?? []).map((r: { result_content?: string }) => r.result_content ?? "").join(" ")}`;
  }
  if (content.trim().length < 20) return { ...NOTHING, dry };
  const corpus = opts.corpus ?? (await readLinkCorpus(sb));
  let adopted = opts.adopted;
  if (!adopted) {
    const r = await readAdoptedVocabulary(sb);
    adopted = r.adopted;
    if (!r.ok) notes.push(r.reason);
  }
  const writes = planLinkWrites(content, corpus, itemId, adopted);
  assertMoatBoundary(writes);
  const edgeWrites = writes.filter((w) => w.table === "item_cross_references");
  const existing = new Map<string, EdgeRowLike>();
  if (edgeWrites.length) {
    const rows = await fetchAllRows<EdgeRowLike>((from, to) => sb.from("item_cross_references").select("id,source_item_id,target_item_id,origin,relationship,basis").eq("source_item_id", itemId).order("id", { ascending: true }).range(from, to), { cap: 10_000 });
    for (const r of rows) existing.set(pairKey(r.source_item_id, r.target_item_id), r);
  }
  const tombstones = edgeWrites.length ? tombstonedPairKeys(await readConnectionCorrectionsFor(sb, itemId)) : new Set<string>();
  const part = partitionLineageWrites(edgeWrites as unknown as { table: string; row: EdgeRowLike }[], existing, tombstones);
  const typed = [...part.inserts, ...part.upgrades].filter((r) => r.relationship !== "related").length;
  let edges = part.inserts.length + part.upgrades.length;
  let surfaced = 0;
  let failed = 0;
  if (!dry) {
    edges = 0;
    if (part.inserts.length) {
      const { error } = await sb.from("item_cross_references").upsert(part.inserts, { onConflict: "source_item_id,target_item_id", ignoreDuplicates: true });
      if (error) {
        failed += part.inserts.length;
        notes.push(`edge insert failed for ${itemId}: ${error.message}`);
      } else edges += part.inserts.length;
    }
    for (const u of part.upgrades) {
      const { error } = await sb.from("item_cross_references").update({ relationship: u.relationship, basis: u.basis }).eq("id", u.id as string);
      if (error) {
        failed += 1;
        notes.push(`edge upgrade failed for ${itemId}: ${error.message}`);
      } else edges += 1;
    }
  }
  for (const w of writes) {
    if (w.table !== "integrity_flags") continue;
    if (await hasOpenFlag(sb, itemId, String(w.row.created_by ?? ""))) continue;
    if (dry) {
      surfaced += 1;
      continue;
    }
    const { error } = await sb.from("integrity_flags").insert(w.row);
    if (error) {
      failed += 1;
      notes.push(`flag ${String(w.row.created_by)} not written for ${itemId}: ${error.message}`);
    } else surfaced += 1;
  }
  return { edges, surfaced, skipped: false, inserted: part.inserts.length, upgraded: part.upgrades.length, skippedForeign: part.skippedForeign.length, conflicts: part.conflicts.length, unchanged: part.unchanged.length, skippedTombstoned: part.skippedTombstoned.length, typed, failed, notes, dry };
}
