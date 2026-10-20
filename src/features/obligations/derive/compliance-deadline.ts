// Ported from old_repo/src/lib/forward-events/compliance-deadline-sync.mjs (lines 1-56)
// Ported from old_repo/scripts/forward-events/dispatch-extraction.mjs (lines 84-103)
// intelligence_items.compliance_deadline is the earliest compliance_deadline event (one whose claim was not suppressed) on or after today (ties: confidence high before medium, then id) and is
// NEVER nulled when no future event exists (INV-220); the Dashboard's Due next reads the column. ONE writer: the update goes through the Db handed in
// (the service client, or a guarded one), and a read or write error throws.
import type { Db } from "@/core/db";
import { notInList, suppressedEventIds } from "@/core/derived/suppressed-events";

export const COMPLIANCE_DEADLINE_EVENT_KIND = "compliance_deadline";
const confRank = (c: unknown): number => (c === "high" ? 0 : c === "medium" ? 1 : 2);

export interface DeadlineCandidate {
  id?: string | null;
  event_date?: string | null;
  event_kind?: string | null;
  confidence?: string | null;
}
/** The earliest future compliance_deadline date among the rows, or null. */
export function pickComplianceDeadline(rows: readonly DeadlineCandidate[] | null | undefined, asOfIso: string): string | null {
  const candidates = (rows ?? [])
    .filter((r): r is DeadlineCandidate & { event_date: string } => !!r && r.event_kind === COMPLIANCE_DEADLINE_EVENT_KIND && typeof r.event_date === "string" && r.event_date >= asOfIso)
    .sort((a, b) => (a.event_date !== b.event_date ? (a.event_date < b.event_date ? -1 : 1) : confRank(a.confidence) - confRank(b.confidence) || String(a.id ?? "").localeCompare(String(b.id ?? ""))));
  return candidates[0]?.event_date ?? null;
}

export type DeadlineSync = { changed: false; reason: string } | { changed: true; value: string };
/** Sync one item's column from its held events. `pending` lets a backfill sync from events it has not inserted yet (a dry run). */
export async function syncComplianceDeadline(sb: Db, itemId: string, asOfIso: string, opts: { dry?: boolean; pending?: readonly DeadlineCandidate[] } = {}): Promise<DeadlineSync> {
  const suppressed = notInList(await suppressedEventIds(sb, itemId));
  const events = sb.from("item_forward_events").select("id, event_date, event_kind, confidence").eq("intelligence_item_id", itemId);
  const { data, error } = await (suppressed ? events.not("id", "in", suppressed) : events);
  if (error) throw new Error(`item_forward_events read failed: ${error.message}`);
  const picked = pickComplianceDeadline([...((data ?? []) as DeadlineCandidate[]), ...(opts.pending ?? [])], asOfIso);
  if (!picked) return { changed: false, reason: "no future compliance_deadline event" };
  const item = await sb.from("intelligence_items").select("compliance_deadline").eq("id", itemId).single();
  if (item.error) throw new Error(`intelligence_items read failed: ${item.error.message}`);
  if ((item.data as { compliance_deadline: string | null } | null)?.compliance_deadline === picked) return { changed: false, reason: "already up to date" };
  if (opts.dry) return { changed: true, value: picked };
  const upd = await sb.from("intelligence_items").update({ compliance_deadline: picked }).eq("id", itemId);
  if (upd.error) throw new Error(`intelligence_items update failed: ${upd.error.message}`);
  return { changed: true, value: picked };
}
