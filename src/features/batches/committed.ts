// New in FLY-1 (ADR-050; no old source: the old drain applied a batch when a workflow was dispatched on its merge). The committed session batches the turn's briefs stage applies: the files the judgement drain committed under
// drain/batches/<kind>/ are read each turn; one the applied_batches ledger has not recorded (or a held one whose file changed) goes through its kind's validator and apply, which grounds every span; a batch is
// recorded `applied` when nothing was refused, or `held` with the reasons in the ledger row and in <batch>.corrections.json next to the file (the next drain plan reads it). A load failure, the cooldown, a failed write or an
// exhausted io budget records nothing, so the next turn tries the batch again (every kind's apply is idempotent per entry). Dry validates and plans the same and writes no ledger row and no file.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { rowsByIds } from "@/core/db";
import type { RunOutcome, RunResult } from "@/core/types/run-result";
import { runResult, worst } from "@/core/types/run-result";
import { resolveKind } from "@/features/drain";

import { applyBatch, type BatchKindId } from "./kit/dispatch";
import type { BatchData, BatchDeps } from "./kit/session-batch";

/** The order a turn applies kinds in: verdicts and searches first, the briefs they feed next, the events and themes read the briefs. */
const ORDER: readonly BatchKindId[] = ["ledger-verdicts", "host-verdicts", "screen-verdicts", "needs-search", "question-answers", "record-briefs", "forward-events", "theme-briefs"];
/** The kinds whose entries are keyed by an item id: the downstream (scores, pending triggers) runs over these. */
const ITEM_KEYED: ReadonlySet<string> = new Set(["record-briefs", "forward-events"]);

/** A kit kind's directory and file-name pattern: the drain's kind table names them (the drain commits the same files); forward-events is no drain queue, so its directory is its own. */
function layoutOf(kind: BatchKindId): { dir: string; re: RegExp } {
  const k = kind === "forward-events" ? null : resolveKind(kind === "screen-verdicts" ? "screen-verdict" : kind);
  return k ? { dir: k.batchDir, re: k.batchRe } : { dir: `drain/batches/${kind}`, re: /^forward-events-\d{3}[a-z0-9-]*\.json$/ };
}

interface CommittedFile { kind: BatchKindId; id: string; dir: string; content: string; hash: string }
/** Every committed batch file under `root`, in apply order (kind, then name). A missing directory is no files. */
function readCommitted(root: string): CommittedFile[] {
  return ORDER.flatMap((kind) => {
    const { dir, re } = layoutOf(kind);
    const at = join(root, dir);
    if (!existsSync(at)) return [];
    return readdirSync(at).filter((n) => re.test(n)).sort().map((name) => {
      const content = readFileSync(join(at, name), "utf8");
      return { kind, id: name.replace(/\.json$/, ""), dir: at, content, hash: createHash("sha256").update(content).digest("hex") };
    });
  });
}

type Verdict = "applied" | "held" | "retry";
/** What the ledger records for an apply result. Pure. */
function verdictOf(r: RunResult): Verdict {
  const c = r.counts;
  const notRead = r.outcome === "failed" && c.entries === undefined && !c.file_refused;
  if (c.guard_refused || c.write_failures || c.not_applied_io_budget || notRead) return "retry";
  return c.file_refused || c.refused || c.read_back_failures ? "held" : "applied";
}

/** The file names in a committed directory under `root`: what the drain plan numbers its next batch after (a corrections file does not match a kind's batch pattern, so it takes no number). */
export function committedNames(root: string, dir: string): string[] {
  const at = join(root, dir);
  return existsSync(at) ? readdirSync(at) : [];
}

export interface CommittedIds { applied_ids: string[]; item_ids: string[]; applied_batch_ids: string[]; held_batch_ids: string[]; read_back_failed_ids: string[] }
const sum = (into: Record<string, number>, from: Record<string, number>) => { for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n; };

/** Apply the committed batches the ledger has not recorded. A ledger that cannot be read applies nothing. */
export async function applyCommitted(deps: BatchDeps, input: { root: string; dry: boolean; runId?: string }): Promise<RunResult<{ ids: CommittedIds }>> {
  const files = readCommitted(input.root);
  const n = { applied: 0, held: 0, retry: 0, skipped: 0 };
  const counts: Record<string, number> = {};
  const ids: CommittedIds = { applied_ids: [], item_ids: [], applied_batch_ids: [], held_batch_ids: [], read_back_failed_ids: [] };
  const notes: string[] = [];
  let outcome: RunOutcome = "ok";
  let ledger: Map<string, { status: string; file_hash: string }>;
  try {
    ledger = new Map((await rowsByIds<{ batch_id: string; status: string; file_hash: string }>(deps.sb, "applied_batches", "batch_id, status, file_hash", files.map((f) => f.id), "batch_id", "batch_id")).map((r) => [r.batch_id, r]));
  } catch (e) {
    return { ...runResult("failed", { batches_found: files.length, refused: 1 }, [`the applied-batches ledger read failed, nothing was applied: ${e instanceof Error ? e.message : String(e)}`]), data: { ids } };
  }
  for (const f of files) {
    const seen = ledger.get(f.id);
    if (seen && (seen.status === "applied" || seen.file_hash === f.hash)) { n.skipped += 1; continue; }
    let named: unknown;
    try { named = (JSON.parse(f.content) as { batch?: unknown }).batch; } catch { named = undefined; }
    const r = (named === f.id
      ? await applyBatch(f.kind, deps, { content: f.content, dry: input.dry, ...(input.runId ? { runId: input.runId } : {}) })
      : runResult("failed", { refused: 1, file_refused: 1 }, [`the file is not a batch named ${f.id} (its batch field is ${JSON.stringify(named)})`])) as RunResult<BatchData>;
    sum(counts, r.counts);
    notes.push(...r.notes.map((n) => `${f.id}: ${n}`));
    const verdict = verdictOf(r);
    if (verdict === "retry") { n.retry += 1; outcome = worst(outcome, "partial"); continue; }
    const applied = r.data?.ids?.applied_ids ?? [];
    const bad = r.data?.ids?.read_back_failed_ids ?? [];
    ids.applied_ids.push(...applied);
    ids.read_back_failed_ids.push(...bad);
    if (ITEM_KEYED.has(f.kind)) ids.item_ids.push(...applied.filter((x) => !bad.includes(x)));
    if (verdict === "held") { n.held += 1; ids.held_batch_ids.push(f.id); outcome = worst(outcome, "partial"); } else { n.applied += 1; ids.applied_batch_ids.push(f.id); }
    if (input.dry) continue;
    const reasons = [...(r.data?.residue ?? []).slice(0, 50).map(({ key, errors }) => ({ key, errors })), ...(verdict === "held" ? [{ key: null, errors: r.notes.slice(0, 12) }] : [])];
    const corrections = join(f.dir, `${f.id}.corrections.json`);
    try {
      const w = await deps.sb.from("applied_batches").upsert({ batch_id: f.id, kind: f.kind, status: verdict, file_hash: f.hash, run_id: input.runId ?? null, counts: r.counts, reasons, recorded_at: deps.now().toISOString() }, { onConflict: "batch_id" });
      if (w.error) throw new Error(w.error.message);
      if (verdict === "held") writeFileSync(corrections, `${JSON.stringify({ batch: f.id, kind: f.kind, held_at: deps.now().toISOString(), file_hash: f.hash, refused: r.data?.residue ?? [], notes: r.notes }, null, 2)}\n`, "utf8");
      else if (existsSync(corrections)) unlinkSync(corrections);
    } catch (e) {
      outcome = worst(outcome, "partial");
      notes.push(`${f.id}: the ledger row or the corrections file was not written (a re-apply writes nothing new): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!files.length) notes.push("no committed batch");
  return { ...runResult(outcome, { ...counts, batches_found: files.length, batches_applied: n.applied, batches_held: n.held, batches_retry: n.retry, batches_skipped: n.skipped }, notes), data: { ids } };
}
