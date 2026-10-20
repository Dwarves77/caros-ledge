// Ported from old_repo/src/lib/forward-events/compliance-deadline-sync.mjs (lines 1-56)
// Ported from old_repo/scripts/forward-events/dispatch-extraction.mjs (lines 84-103)
// intelligence_items.compliance_deadline is the earliest claim-grounded compliance_deadline event (one whose source_claim_id is present and not suppressed) on or after today (ties: confidence high before medium, then id) on a binding instrument class, and is
// NEVER nulled on a binding instrument when no future event exists (INV-220); the Dashboard's Due next reads the column. ONE writer: the update goes through the Db handed in
// (the service client, or a guarded one), and a read or write error throws.
import type { Db } from "@/core/db";
import { notInList, suppressedEventIds } from "@/core/derived/suppressed-events";

import { isBindingInstrumentType } from "../kinds";

const COMPLIANCE_DEADLINE_EVENT_KIND = "compliance_deadline";
const confRank = (c: unknown): number => (c === "high" ? 0 : c === "medium" ? 1 : 2);

export interface DeadlineCandidate {
  id?: string | null;
  event_date?: string | null;
  event_kind?: string | null;
  confidence?: string | null;
  source_claim_id?: string | null;
}

const isClaimGrounded = (r: DeadlineCandidate): boolean => typeof r.source_claim_id === "string" && r.source_claim_id.trim().length > 0;

/** The earliest future claim-grounded compliance_deadline date among the rows, or null. */
function pickComplianceDeadline(rows: readonly DeadlineCandidate[] | null | undefined, asOfIso: string): { picked: string | null; hadUngroundedFutureDeadline: boolean } {
  const futureDeadlines = (rows ?? []).filter(
    (r): r is DeadlineCandidate & { event_date: string } => !!r && r.event_kind === COMPLIANCE_DEADLINE_EVENT_KIND && typeof r.event_date === "string" && r.event_date >= asOfIso
  );
  const grounded = futureDeadlines
    .filter(isClaimGrounded)
    .sort((a, b) => (a.event_date !== b.event_date ? (a.event_date < b.event_date ? -1 : 1) : confRank(a.confidence) - confRank(b.confidence) || String(a.id ?? "").localeCompare(String(b.id ?? ""))));
  return {
    picked: grounded[0]?.event_date ?? null,
    hadUngroundedFutureDeadline: grounded.length === 0 && futureDeadlines.length > 0,
  };
}

export type DeadlineSync = { changed: false; reason: string } | { changed: true; value: string };
/** Sync one item's column from its held events. `pending` lets a backfill sync from events it has not inserted yet (a dry run). */
export async function syncComplianceDeadline(sb: Db, itemId: string, asOfIso: string, opts: { dry?: boolean; pending?: readonly DeadlineCandidate[] } = {}): Promise<DeadlineSync> {
  const item = await sb.from("intelligence_items").select("item_type, compliance_deadline").eq("id", itemId).single();
  if (item.error) throw new Error(`intelligence_items read failed: ${item.error.message}`);
  const itemData = item.data as { item_type?: string | null; compliance_deadline: string | null } | null;
  if (itemData?.item_type != null && !isBindingInstrumentType(itemData.item_type)) {
    if (itemData.compliance_deadline !== null && !opts.dry) {
      const clr = await sb.from("intelligence_items").update({ compliance_deadline: null }).eq("id", itemId);
      if (clr.error) throw new Error(`intelligence_items update failed: ${clr.error.message}`);
    }
    return { changed: false, reason: "non-binding item type has no compliance_deadline" };
  }
  const suppressed = notInList(await suppressedEventIds(sb, itemId));
  const events = sb.from("item_forward_events").select("id, event_date, event_kind, confidence, source_claim_id").eq("intelligence_item_id", itemId);
  const { data, error } = await (suppressed ? events.not("id", "in", suppressed) : events);
  if (error) throw new Error(`item_forward_events read failed: ${error.message}`);
  const { picked, hadUngroundedFutureDeadline } = pickComplianceDeadline([...((data ?? []) as DeadlineCandidate[]), ...(opts.pending ?? [])], asOfIso);
  if (!picked) {
    return {
      changed: false,
      reason: hadUngroundedFutureDeadline
        ? "refused: compliance_deadline event has no source_claim_id"
        : "no future compliance_deadline event",
    };
  }
  if (itemData?.compliance_deadline === picked) return { changed: false, reason: "already up to date" };
  if (opts.dry) return { changed: true, value: picked };
  const upd = await sb.from("intelligence_items").update({ compliance_deadline: picked }).eq("id", itemId);
  if (upd.error) throw new Error(`intelligence_items update failed: ${upd.error.message}`);
  return { changed: true, value: picked };
}
