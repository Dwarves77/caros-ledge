// The operator proofs as queries over the one ledger (harness.md section 8, "Proof that the module works"): P1 chain, P2 minted ids, P3 flywheel outcomes, P4 change, P5 smoke by code_sha. P6 is CI.
import { fetchAllRows, type Db } from "@/core/db";
import { FAMILIES } from "@/core/harness/families";
import { countsOf } from "@/core/harness/outcome";
import type { RunRow } from "@/core/harness/record";

type Ledger = Pick<RunRow, "id" | "family" | "root_run_id" | "upstream_run_id" | "mode" | "outcome" | "outputs" | "code_sha" | "started_at">;
const COLUMNS = "id,family,root_run_id,upstream_run_id,mode,outcome,outputs,code_sha,started_at";

type Order = { order: (c: string, o: object) => Order & { range: (a: number, b: number) => never } };
/** The ledger rows a filter selects, paged in a TOTAL order: `started_at` is not unique (a recorder stamps many unit rows with one instant), so the id breaks the tie and no page boundary skips or repeats a row. */
async function rows(sb: Db, apply: (q: ReturnType<ReturnType<Db["from"]>["select"]>) => unknown): Promise<Ledger[]> {
  return fetchAllRows<Ledger>((from, to) => (apply(sb.from("harness_runs").select(COLUMNS)) as Order).order("started_at", { ascending: true }).order("id", { ascending: true }).range(from, to), { cap: 50_000 });
}
const counts = (r: Ledger): Record<string, number> => countsOf(r.outputs);

/** P1: under one root, every stage family left a row and none failed or finished partial (some of its units failed: the proof is not ok). A stage a gate held (refused) or that had nothing to do (noop) is recorded and listed, not a break; `held` names them. */
export async function chainProof(sb: Db, rootRunId: string, expect: readonly string[] = FAMILIES.filter((f) => f.stage).map((f) => f.name)) {
  const all = await rows(sb, (q) => (q as unknown as { eq: (c: string, v: string) => unknown }).eq("root_run_id", rootRunId));
  const missing = expect.filter((f) => !all.some((r) => r.family === f));
  const failed = all.filter((r) => r.outcome === "failed").map((r) => r.family);
  const partial = all.filter((r) => r.outcome === "partial").map((r) => r.family);
  const held = all.filter((r) => r.outcome === "refused" || r.outcome === "noop").map((r) => `${r.family}:${r.outcome}`);
  return { ok: missing.length === 0 && failed.length === 0 && partial.length === 0, missing, failed, partial, held, rows: all };
}

/** P2: the item ids minted by apply runs that succeeded or finished partial (the items a partial run did mint exist), newest first. */
export async function mintedIds(sb: Db): Promise<string[]> {
  const all = await rows(sb, (q) => (q as unknown as { eq: (c: string, v: string) => unknown }).eq("mode", "apply"));
  return all.filter((r) => r.outcome === "success" || r.outcome === "partial").reverse().flatMap((r) => ((r.outputs.ids as Record<string, string[]> | undefined)?.minted_item_ids ?? []));
}

/** P3: the rows that share a minted run's root in the flywheel families, with the output count above zero. */
export async function flywheelOutcomes(sb: Db, rootRunIds: readonly string[]) {
  const all = (await rows(sb, (q) => q)).filter((r) => rootRunIds.includes(r.root_run_id) && ["corpus-turn", "propagation"].includes(r.family));
  return all.map((r) => ({ id: r.id, family: r.family, root_run_id: r.root_run_id, outputTotal: Object.values(counts(r)).reduce((n, v) => n + (Number.isFinite(v) ? v : 0), 0) })).filter((r) => r.outputTotal > 0);
}

/** P4: an applied change-detection run that detected at least one change. */
export async function changeProof(sb: Db): Promise<Ledger[]> {
  return (await rows(sb, (q) => (q as unknown as { eq: (c: string, v: string) => unknown }).eq("family", "change-detection"))).filter((r) => r.mode === "apply" && (counts(r).changes_detected ?? 0) >= 1);
}

/** P5: the live-smoke row of the deployed code_sha, and whether it succeeded. */
export async function smokeProof(sb: Db, codeSha: string): Promise<{ ok: boolean; row: Ledger | null }> {
  const hit = (await rows(sb, (q) => (q as unknown as { eq: (c: string, v: string) => unknown }).eq("family", "live-smoke"))).filter((r) => r.code_sha === codeSha).pop() ?? null;
  return { ok: hit?.outcome === "success", row: hit };
}
