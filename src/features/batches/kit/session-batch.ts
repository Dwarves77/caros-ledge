// Ported from old_repo/scripts/turns/needs-search/schema.mjs (lines 124-151)
// Ported from old_repo/scripts/turns/question-answers/schema.mjs (lines 190-222)
// Ported from old_repo/scripts/turns/apply-need-urls.mjs (lines 186-294)
// Ported from old_repo/scripts/turns/apply-question-answers.mjs (lines 225-326)
// Ported from old_repo/scripts/turns/apply-theme-briefs.mjs (lines 120-195)
// The session-batch engine: the one validator pattern and the one apply loop every kind plugs into. A session authors a batch file from an exported bundle; the batch is validated WHOLE against the live material
// (a structural defect refuses the whole file; a defective entry is refused alone, with its reasons kept as residue; an entry already applied is "already applied", never a refusal), then written, read back, and its
// downstream is called in the same run (rule 17). Nothing here calls a model: the session is the author. A runtime entry never exits the process and reads the clock only through `deps.now`.
import type { Db } from "@/core/db";
import { poolHash, readPool } from "@/core/grounding";
import type { HostVerdictRef } from "@/core/sources";
import type { RunResult } from "@/core/types/run-result";
import { runResult } from "@/core/types/run-result";
import type { ExportResult } from "@/features/drain";
import type { IntakeDeps } from "@/features/intake";

export type Obj = Record<string, unknown>;
export const isObj = (x: unknown): x is Obj => x !== null && typeof x === "object" && !Array.isArray(x);
export const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;

/** What an exporter returns: the drain's queue items plus, for the bundle file, a summary and the residue the export could not list. */
export interface BatchExport extends ExportResult { summary?: Obj; residue?: unknown[] }

/** Everything a batch kind needs from the turn, by member name (BuiltDeps satisfies it; the stage passes the members). */
export interface BatchDeps {
  sb: Db;
  now(): Date;
  intake: IntakeDeps;
  /** Committed host verdicts for rating a host the class table does not place. */
  verdicts?: ReadonlyMap<string, HostVerdictRef> | null | undefined;
  /** The public cache flush (the app's revalidate route); absent means a flush is owed and the run says so. */
  flushCache?: ((tags: string[]) => Promise<{ error: string | null }>) | undefined;
}
export interface ApplyOpts {
  dry: boolean;
  /** The harness run id of THIS firing: the cooldown ignores its own ledger row. */
  runId?: string;
  /** Apply only the entries after this key, at most `limit` of them (the next dispatch resumes where a stopped one ended). */
  afterKey?: string | null;
  limit?: number | null;
  /** Stop cleanly before the bytes the entries read would pass this many (0 or absent: no budget). */
  budgetBytes?: number;
  [k: string]: unknown;
}

// ---- reads -----------------------------------------------------------------------------------------------------

/** An item's stored pool as the hash and the text every batch is authored against; a failed read throws. */
export async function itemPool(sb: Db, itemId: string): Promise<{ pool: { url: string; text: string }[]; hash: string; bytes: number }> {
  const pool = (await readPool(sb, itemId)).map((p) => ({ url: p.url, text: p.text }));
  return { pool, hash: poolHash(pool), bytes: pool.reduce((n, p) => n + Buffer.byteLength(p.text, "utf8"), 0) };
}
/** INV-207: an entry is applied only against the held pool it was authored from. */
export const poolHashError = (subject: string, authored: unknown, live: string): string | null =>
  !nonEmpty(authored) ? `${subject}: the pool hash is missing` : authored === live ? null : `${subject}: stale pool: authored against ${authored}, the live held pool is ${live}; re-export and re-author`;

// ---- the one validator pattern -----------------------------------------------------------------------------------
export interface EntryResult<P> {
  errors: string[];
  plan?: P;
  /** The entry's work is already done: a re-apply writes nothing new (INV-210). */
  done?: boolean;
}
export interface Item<P> { index: number; key: string | null; entry: Obj; plan: P }
export interface Verdict<P> {
  fileErrors: string[];
  valid: Item<P>[];
  refused: { index: number; key: string | null; errors: string[] }[];
  alreadyApplied: { index: number; key: string | null; why: string }[];
}
export interface Written<P> extends Item<P> { ref: string; notes: string[]; counts: Record<string, number> }

export interface EntrySpec<L, P> {
  kind: string;
  /** The batch name pattern, e.g. /^needs-search-[A-Za-z0-9._-]+$/. */
  batchRe: RegExp;
  /** The key that names an entry (a duplicate in one batch is refused). */
  keyOf(entry: Obj): string | null;
  ceiling?: number;
  /** The live material the batch is checked against: bounded reads, one set per apply. */
  load(deps: BatchDeps, file: Obj): Promise<L>;
  entry(entry: unknown, index: number, live: L): EntryResult<P>;
  /** Write one valid entry; returns a reference to what was written. May throw: a throw is that entry's write failure. */
  write(deps: BatchDeps, live: L, item: Item<P>, batch: string): Promise<{ ref: string; notes?: string[]; counts?: Record<string, number> }>;
  /** Keys whose stored result does not match what was written (INV-210: every write is read back). */
  readBack?(deps: BatchDeps, live: L, written: readonly Written<P>[], batch: string): Promise<string[]>;
  /** The run's downstream (rule 17); null when the kind has none to run. */
  downstream?(deps: BatchDeps, live: L, written: readonly Written<P>[], o: ApplyOpts): Promise<RunResult | null>;
  /** Bytes an entry reads: the loop stops cleanly before the running total passes `budgetBytes`. */
  cost?(item: Item<P>, live: L): number;
  /** Stop before the first write when this returns a reason (the cooldown and the in-flight guard). */
  guard?(deps: BatchDeps, o: ApplyOpts): Promise<string | null>;
}

/** The structural problems of the file as a whole (empty when it can be read entry by entry). */
export function fileShapeErrors(json: unknown, spec: Pick<EntrySpec<never, never>, "batchRe" | "ceiling">): string[] {
  if (!isObj(json)) return ["file is not a JSON object"];
  const problems: string[] = [];
  if (!nonEmpty(json.batch) || !spec.batchRe.test(json.batch)) problems.push(`batch must match ${spec.batchRe} (got ${JSON.stringify(json.batch)})`);
  if (!nonEmpty(json.generated_at) || Number.isNaN(Date.parse(json.generated_at))) problems.push("generated_at must be an ISO timestamp");
  if (json.authored_by !== "session-lane") problems.push(`authored_by must be "session-lane" (got ${JSON.stringify(json.authored_by)})`);
  if (!Array.isArray(json.entries)) problems.push("entries must be an array");
  else if (spec.ceiling && json.entries.length > spec.ceiling) problems.push(`entries has ${json.entries.length} items, ceiling ${spec.ceiling}`);
  return problems;
}

/** Validate a whole batch against the live material. Pure. A structural problem fails the whole file; a problem in one entry refuses that entry only; a repeated key is refused. */
export function validateEntries<L, P>(spec: EntrySpec<L, P>, file: unknown, live: L): Verdict<P> {
  const fileErrors = fileShapeErrors(file, spec);
  const verdict: Verdict<P> = { fileErrors, valid: [], refused: [], alreadyApplied: [] };
  if (fileErrors.length || !isObj(file)) return verdict;
  const seen = new Set<string>();
  (file.entries as unknown[]).forEach((entry, index) => {
    const key = isObj(entry) ? spec.keyOf(entry) : null;
    const r = spec.entry(entry, index, live);
    if (!r.errors.length && key && seen.has(key)) r.errors.push(`entry ${index} (${key}): duplicate key in this batch`);
    if (key) seen.add(key);
    if (r.errors.length) verdict.refused.push({ index, key, errors: r.errors });
    else if (r.done) verdict.alreadyApplied.push({ index, key, why: "already applied" });
    else verdict.valid.push({ index, key, entry: entry as Obj, plan: r.plan as P });
  });
  return verdict;
}

const refusalNotes = (v: Verdict<unknown>, cap = 12): string[] => {
  const all = v.refused.flatMap((r) => r.errors);
  return [...all.slice(0, cap), ...(all.length > cap ? [`... and ${all.length - cap} more refusal reason(s)`] : [])];
};

export interface BatchData { batch: string | null; ids: Record<string, string[]>; residue: { index: number; key: string | null; errors: string[] }[]; alreadyApplied: string[]; downstream: { counts: Record<string, number>; outcome: string; notes: string[] } | null }

/**
 * The one apply: load the live material, validate whole, then (not dry) write each valid entry, read every write back, and call the kind's downstream. Counts: entries, valid, refused, already_applied, applied,
 * write_failures, read_back_failures; `applied` is what the ledger reads as work done. Never throws: a failed load or a thrown write is a failed or partial result.
 */
export async function applyEntries<L, P>(spec: EntrySpec<L, P>, deps: BatchDeps, file: unknown, o: ApplyOpts): Promise<RunResult<BatchData>> {
  const batch = isObj(file) && typeof file.batch === "string" ? file.batch : null;
  const empty: BatchData = { batch, ids: {}, residue: [], alreadyApplied: [], downstream: null };
  const early = fileShapeErrors(file, spec);
  if (early.length) return { ...runResult("failed", { refused: 1, file_refused: 1 }, early.map((e) => `${spec.kind}: batch refused whole: ${e}`)), data: empty };
  let live: L;
  try {
    live = await spec.load(deps, file as Obj);
  } catch (e) {
    return { ...runResult("failed", { refused: 1 }, [`${spec.kind}: the live material could not be read, nothing was applied: ${e instanceof Error ? e.message : String(e)}`]), data: empty };
  }
  const v = validateEntries(spec, file, live);
  const counts: Record<string, number> = { entries: (file as Obj & { entries: unknown[] }).entries.length, valid: v.valid.length, refused: v.refused.length, already_applied: v.alreadyApplied.length, applied: 0, write_failures: 0, read_back_failures: 0 };
  const data: BatchData = { ...empty, residue: v.refused, alreadyApplied: v.alreadyApplied.map((a) => a.key ?? String(a.index)) };
  const notes = refusalNotes(v);
  const after = o.afterKey ? v.valid.findIndex((x) => x.key === o.afterKey) : -1;
  const todo = v.valid.slice(after + 1, typeof o.limit === "number" && o.limit >= 0 ? after + 1 + o.limit : undefined);
  counts.not_selected = v.valid.length - todo.length;
  if (o.dry || !todo.length) {
    const nothing = !v.valid.length && v.refused.length > 0 && !v.alreadyApplied.length;
    return { ...runResult(nothing ? "failed" : v.refused.length ? "partial" : "ok", nothing ? { ...counts, refused: v.refused.length } : counts, [...notes, o.dry ? `dry: ${todo.length} valid entr${todo.length === 1 ? "y" : "ies"}, nothing written` : "no valid entry to write"]), data };
  }
  const stop = spec.guard ? await spec.guard(deps, o) : null;
  if (stop) return { ...runResult("failed", { ...counts, refused: Math.max(1, v.refused.length), guard_refused: 1 }, [`${spec.kind}: ${stop}`, ...notes]), data };

  const written: Written<P>[] = [];
  const budget = o.budgetBytes ?? 0;
  let spent = 0;
  let stoppedAt: string | null = null;
  for (const item of todo) {
    const cost = spec.cost?.(item, live) ?? 0;
    if (budget > 0 && spent + cost > budget) {
      stoppedAt = item.key ?? String(item.index);
      break;
    }
    try {
      const w = await spec.write(deps, live, item, batch as string);
      written.push({ ...item, ref: w.ref, notes: w.notes ?? [], counts: w.counts ?? {} });
      notes.push(...(w.notes ?? []));
      for (const [k, n] of Object.entries(w.counts ?? {})) counts[k] = (counts[k] ?? 0) + n;
      spent += cost;
      counts.applied = (counts.applied as number) + 1;
    } catch (e) {
      counts.write_failures = (counts.write_failures as number) + 1;
      notes.push(`${spec.kind} ${item.key ?? item.index}: write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (stoppedAt) {
    counts.not_applied_io_budget = todo.length - written.length - (counts.write_failures as number);
    notes.push(`${spec.kind}: io budget of ${budget} byte(s) reached after ${spent}; stopped before ${stoppedAt} (resume with the remaining entries)`);
  }
  if (spec.readBack && written.length) {
    try {
      const bad = await spec.readBack(deps, live, written, batch as string);
      counts.read_back_failures = bad.length;
      for (const k of bad) notes.push(`${spec.kind} ${k}: read-back failed: the stored result does not match what was written`);
    } catch (e) {
      counts.read_back_failures = written.length;
      notes.push(`${spec.kind}: read-back could not run: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  data.ids = { applied_ids: written.map((w) => w.key ?? String(w.index)) };
  let down: RunResult | null = null;
  if (spec.downstream && written.length) {
    try {
      down = await spec.downstream(deps, live, written, o);
    } catch (e) {
      down = runResult("failed", {}, [`downstream threw: ${e instanceof Error ? e.message : String(e)}`]);
    }
    if (down) {
      data.downstream = { counts: down.counts, outcome: down.outcome, notes: down.notes };
      for (const [k, n] of Object.entries(down.counts)) counts[`downstream_${k}`] = n;
      if (down.outcome !== "ok") notes.push(`${spec.kind} downstream ${down.outcome}: ${down.notes.slice(0, 3).join("; ")}`);
    }
  }
  const bad = counts.write_failures || counts.read_back_failures || v.refused.length || stoppedAt || (down && down.outcome !== "ok");
  const outcome = !counts.applied ? "failed" : bad ? "partial" : "ok";
  return { ...runResult(outcome, counts, notes), data };
}
