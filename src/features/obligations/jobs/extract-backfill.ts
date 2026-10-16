// Ported from old_repo/scripts/forward-events/dispatch-extraction.mjs (lines 1-113)
// The forward-event backfill (INV-108): extract for live items that hold zero events, insert through the one writer, sync compliance_deadline through the
// one deadline writer. Resumable by `afterId` (the last id processed is returned). Dry by default at the caller: `dry` is required. No clock but deps.now.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import type { RunResult } from "@/core/sources/run-result";

import { syncComplianceDeadline } from "../derive/compliance-deadline";
import { insertForwardEvents } from "../extract/write-forward-events";
import { readAndExtractForwardEvents } from "../extract/verbatim-in-source";

export interface BackfillDeps {
  sb: Db;
  now: () => Date;
}
export interface BackfillInput {
  dry: boolean;
  limit?: number;
  afterId?: string | null;
}

export async function extractBackfill(deps: BackfillDeps, input: BackfillInput): Promise<RunResult<{ lastId: string | null }>> {
  const { sb } = deps;
  const today = deps.now().toISOString().slice(0, 10);
  const covered = new Set((await fetchAllRows<{ intelligence_item_id: string }>((from, to) => sb.from("item_forward_events").select("intelligence_item_id").order("id", { ascending: true }).range(from, to), { cap: 2_000_000 })).map((r) => r.intelligence_item_id));
  let items = await fetchAllRows<{ id: string; title: string | null }>((from, to) => {
    let q = sb.from("intelligence_items").select("id, title").eq("is_archived", false);
    if (input.afterId) q = q.gt("id", input.afterId);
    return q.order("id", { ascending: true }).range(from, to);
  }, { cap: 1_000_000 });
  items = items.filter((it) => !covered.has(it.id));
  if (input.limit) items = items.slice(0, input.limit);
  const counts: Record<string, number> = { scope: items.length, items_with_events: 0, events: 0, inserted: 0, collisions: 0, deadlines_synced: 0, failed: 0 };
  const notes: string[] = [];
  for (const it of items) {
    try {
      const r = await readAndExtractForwardEvents(sb, it.id, deps.now());
      if (!r.events.length) continue;
      counts.items_with_events = (counts.items_with_events ?? 0) + 1;
      counts.events = (counts.events ?? 0) + r.events.length;
      const w = await insertForwardEvents(sb, it.id, r.events, { claimIds: new Set(r.claims.map((c) => c.claim_id)), sectionIds: new Set(r.sections.map((s) => s.section_id)) }, { dry: input.dry });
      counts.inserted = (counts.inserted ?? 0) + w.inserted;
      counts.collisions = (counts.collisions ?? 0) + w.collisions;
      const sync = await syncComplianceDeadline(sb, it.id, today, { dry: input.dry, pending: input.dry ? r.events.map((e, i) => ({ ...e, id: `pending-${i}` })) : [] });
      if (sync.changed) counts.deadlines_synced = (counts.deadlines_synced ?? 0) + 1;
    } catch (e) {
      counts.failed = (counts.failed ?? 0) + 1;
      notes.push(`${it.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const last = items.length ? (items[items.length - 1] as { id: string }).id : null;
  if (input.dry) notes.push("dry: nothing written");
  return { counts, outcome: counts.failed ? (counts.items_with_events || items.length > counts.failed ? "partial" : "failed") : "ok", notes, data: { lastId: last } };
}
