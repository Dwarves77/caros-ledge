// Ported from old_repo/scripts/turns/brief-export/queue.mjs (lines 1-181)
// Ported from old_repo/scripts/turns/read-brief-export-queue.mjs (lines 1-105)
// The brief queue: what an export put in front of a session and has not been applied yet. There is no queue table and no queue row to write: an export run's own ledger row carries the exported item ids and the part
// file paths (ids and paths ONLY: never pool text, so reading the queue reads no pool; the old queue row held every pool in inputs_ref), and an apply run's row carries the ids it applied. Pending is exported minus
// applied. The writer is the run frame (the batch result's `ids`), the reader is here, and the same rows serve both.
import { boundedRead, type Db } from "@/core/db";
import { MAX_BOUND } from "@/core/db";

export const QUEUE_FAMILY = "brief-apply";
export const QUEUE_WINDOW = MAX_BOUND;

interface LedgerRow { id: string; started_at: string; outcome: string; mode: string | null; outputs: { ids?: Record<string, string[]> } | null }
export interface QueueEntry { runId: string; exportedAt: string; ids: string[]; parts: string[] }

/** The ids a run exported and the part paths it wrote. Pure over a ledger row. */
export const exportedBy = (r: LedgerRow): { ids: string[]; parts: string[] } => ({ ids: r.outputs?.ids?.exported_ids ?? [], parts: r.outputs?.ids?.parts ?? [] });
/** Pending queue entries: each export run's ids that no apply run in the window has applied, oldest first. Pure over the window. */
export function pendingFrom(rows: readonly LedgerRow[]): QueueEntry[] {
  const applied = new Set(rows.flatMap((r) => r.outputs?.ids?.applied_ids ?? []));
  return rows
    .filter((r) => exportedBy(r).ids.length > 0)
    .map((r) => ({ runId: r.id, exportedAt: r.started_at, ids: exportedBy(r).ids.filter((id) => !applied.has(id)), parts: exportedBy(r).parts }))
    .filter((e) => e.ids.length > 0)
    .sort((a, b) => a.exportedAt.localeCompare(b.exportedAt) || a.runId.localeCompare(b.runId));
}

/** The latest brief-apply rows (dry rows carry the same ids; a failed row carries none). A failed read throws: an unreadable ledger is never "the queue is empty". */
async function window(sb: Db): Promise<LedgerRow[]> {
  const r = await boundedRead<LedgerRow>((limit) => sb.from("harness_runs").select("id, started_at, outcome, mode, outputs").eq("family", QUEUE_FAMILY).order("started_at", { ascending: false }).limit(limit), { limit: QUEUE_WINDOW });
  if (r.error) throw new Error(`harness_runs read failed: ${r.error.message}`);
  return r.data;
}
export async function readBriefQueue(sb: Db): Promise<QueueEntry[]> {
  return pendingFrom(await window(sb));
}
/** One export run's queued content: the ids and the part paths. Null when the run is not in the window or exported nothing. */
export async function resolveQueueEntry(sb: Db, runId: string): Promise<QueueEntry | null> {
  const row = (await window(sb)).find((r) => r.id === runId);
  return row && exportedBy(row).ids.length ? { runId: row.id, exportedAt: row.started_at, ...exportedBy(row) } : null;
}
