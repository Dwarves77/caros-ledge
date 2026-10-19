// Ported from old_repo/scripts/turns/run-population-flywheel.mjs (lines 728-952)
// THE GATE (INV-195): a minted slice is connected before the next one mints, and a slice whose ids are gone refuses instead of being connected with a zero outcome.
// Read from the run ledger (harness_runs), never from a directory.
import { fetchAllRows, type Db } from "@/core/db";

const MINTERS = ["ledger-consume", "research-walker"] as const;
const CONNECTOR = "corpus-turn";
type Row = { id: string; family: string; root_run_id: string; outputs: { ids?: Record<string, string[]>; counts?: Record<string, number> } };

export interface SliceState {
  /** Minted item ids no connect run has covered. */
  unconnected: string[];
  /** Apply runs that claim a mint and carry no ids: they cannot be connected and refuse. */
  unrecoverable: { runId: string; family: string; minted: number }[];
}

/** Which minted items has no connect run covered? Pure over the ledger rows. */
export function sliceState(rows: readonly Row[]): SliceState {
  const connected = new Set(rows.filter((r) => r.family === CONNECTOR).flatMap((r) => r.outputs.ids?.connected_item_ids ?? []));
  const minters = rows.filter((r) => (MINTERS as readonly string[]).includes(r.family));
  const unrecoverable = minters.filter((r) => (r.outputs.counts?.minted ?? 0) > 0 && !(r.outputs.ids?.minted_item_ids ?? []).length).map((r) => ({ runId: r.id, family: r.family, minted: r.outputs.counts?.minted ?? 0 }));
  const unconnected = [...new Set(minters.flatMap((r) => r.outputs.ids?.minted_item_ids ?? []))].filter((id) => !connected.has(id));
  return { unconnected, unrecoverable };
}

/** Read every applied minter and connector row (a partial run minted what it minted, so it counts), paged in the total order (started_at, id). A failed read throws: an unreadable ledger never reads as "all connected". */
export async function readSliceState(sb: Db): Promise<SliceState> {
  const rows = await fetchAllRows<Row>((from, to) => sb.from("harness_runs").select("id,family,root_run_id,outputs").eq("mode", "apply").in("outcome", ["success", "partial"]).in("family", [...MINTERS, CONNECTOR]).order("started_at", { ascending: true }).order("id", { ascending: true }).range(from, to), { cap: 100_000 });
  return sliceState(rows);
}

/** The refusal text for a mint that would start a new slice over an unconnected one, or null when the way is clear. */
export function gateRefusal(s: SliceState): string | null {
  if (!s.unconnected.length && !s.unrecoverable.length) return null;
  const parts = [s.unconnected.length ? `${s.unconnected.length} minted item(s) were never connected (first: ${s.unconnected.slice(0, 3).join(", ")})` : "", s.unrecoverable.length ? `${s.unrecoverable.length} apply run(s) minted items but carry no recoverable ids (${s.unrecoverable.map((u) => u.runId).join(", ")}); they need resolving by hand` : ""].filter(Boolean);
  return `THE GATE: ${parts.join("; ")}. A runtime that ends without triggering its downstream is a defect: run \`turn --stage connect --mode apply\` to close the backlog, then re-dispatch.`;
}
