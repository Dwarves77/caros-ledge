// Ported from old_repo/src/lib/intake/flywheel-steps.mjs (lines 5-17)
// Ported from old_repo/src/lib/intake/flywheel-steps.mjs (lines 53-107)
// Ported from old_repo/src/lib/intake/mint-enrichment.ts (lines 51-56)
// Ported from old_repo/scripts/forward-events/dispatch-extraction.mjs (lines 69-81)
// THE writer of item_forward_events (three writers with three dedupe postures became one). Identity is the migration-307 key (item, kind, date, md5 of
// the text): events already held and repeats inside the batch are not inserted. A unique violation (23505) is a counted collision, and the rows are then
// retried one at a time so the non-colliding ones still land. Events whose supporting claim or section no longer exists are REPORTED (staleIds), never deleted.
import { createHash } from "node:crypto";

import type { Db } from "@/core/db";

import type { ExtractedEvent } from "./dedupe";

const md5Hex = (s: unknown): string => createHash("md5").update(String(s ?? ""), "utf8").digest("hex");
/** The identity of an event within an item: the key of uq_item_forward_events_text_identity. */
export const forwardEventKey = (row: { event_date: string; event_kind: string; obligation_text: string }): string => `${row.event_date}|${row.event_kind}|${md5Hex(row.obligation_text)}`;

export interface InsertResult {
  attempted: number;
  inserted: number;
  collision: boolean;
  collisions: number;
  staleIds: string[];
}

/** Insert the new events of one item; `current` names the claim and section ids that still exist (for the stale report). Dry reads and plans only. */
export async function insertForwardEvents(sb: Db, itemId: string, events: readonly ExtractedEvent[], current: { claimIds: ReadonlySet<string>; sectionIds: ReadonlySet<string> }, opts: { dry?: boolean } = {}): Promise<InsertResult> {
  const { data, error } = await sb.from("item_forward_events").select("id, event_date, event_kind, obligation_text, source_claim_id, source_section_id").eq("intelligence_item_id", itemId).order("id", { ascending: true });
  if (error) throw new Error(`item_forward_events read failed: ${error.message}`);
  const existing = (data ?? []) as { id: string; event_date: string; event_kind: string; obligation_text: string; source_claim_id: string | null; source_section_id: string | null }[];
  const staleIds = existing.filter((r) => (r.source_claim_id ? !current.claimIds.has(r.source_claim_id) : r.source_section_id ? !current.sectionIds.has(r.source_section_id) : false)).map((r) => r.id);
  const known = new Set(existing.map(forwardEventKey));
  const rows: Record<string, unknown>[] = [];
  for (const ev of events) {
    const key = forwardEventKey(ev);
    if (known.has(key)) continue;
    known.add(key);
    rows.push({ intelligence_item_id: itemId, ...ev });
  }
  const out: InsertResult = { attempted: rows.length, inserted: 0, collision: false, collisions: 0, staleIds };
  if (!rows.length || opts.dry) return out;
  const batch = await sb.from("item_forward_events").insert(rows);
  if (!batch.error) return { ...out, inserted: rows.length };
  if (batch.error.code !== "23505") throw new Error(`item_forward_events insert failed: ${batch.error.message}`);
  out.collision = true;
  for (const row of rows) {
    const one = await sb.from("item_forward_events").insert(row);
    if (!one.error) out.inserted += 1;
    else if (one.error.code === "23505") out.collisions += 1;
    else throw new Error(`item_forward_events insert failed: ${one.error.message}`);
  }
  return out;
}
