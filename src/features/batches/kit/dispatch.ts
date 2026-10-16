// Ported from old_repo/scripts/drain/kinds.mjs (lines 1-221)
// Ported from old_repo/scripts/turns/export-corpus-for-extraction.mjs (lines 88-130)
// Ported from old_repo/scripts/turns/needs-search/artifact.mjs (lines 1-22)
// Ported from old_repo/scripts/turns/question-answers/artifact.mjs (lines 1-28)
// The kit's front door: the kind table, `exportBatch` (a bundle to a scratch directory, never the repo, in parts under a character budget), `applyBatch` (a batch content to the kind's apply), and `validateBatch` (the pure
// check of a file against already-loaded live material). One exporter per kind: `drainExporters` hands the SAME functions to the judgement drain. The ledger row is the run frame's, written from the result these return.
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import type { Exporter } from "@/features/drain";
import { runResult } from "@/core/types/run-result";
import type { RunResult } from "@/core/types/run-result";

import { applyForwardEvents } from "../kinds/forward-events/apply";
import { forwardEventsExporter } from "../kinds/forward-events/export";
import { applyLedgerVerdicts, ledgerVerdictsExporter } from "../kinds/ledger-verdicts/apply";
import { applyNeedsSearch, needsSearchSpec } from "../kinds/needs-search/apply";
import { needsExporter } from "../kinds/needs-search/needs";
import { applyQuestionAnswers, questionAnswersSpec, questionExporter } from "../kinds/question-answers/apply";
import { applyRecordBriefs, recordBriefsSpec } from "../kinds/record-briefs/apply";
import { recordBriefsExporter } from "../kinds/record-briefs/export";
import { applyScreenVerdicts, screenVerdictsExporter } from "../kinds/screen-verdicts/apply";
import { applyThemeBriefs, themeBriefsExporter } from "../kinds/theme-briefs/apply";
import { forwardEventsSpec } from "../kinds/forward-events/apply";
import { themeBriefsSpec } from "../kinds/theme-briefs/apply";

import { validateEntries, type ApplyOpts, type BatchDeps, type BatchExport, type EntrySpec, type Obj, type Verdict } from "./session-batch";

export const BATCH_KINDS = ["record-briefs", "question-answers", "needs-search", "forward-events", "theme-briefs", "screen-verdicts", "ledger-verdicts"] as const;
export type BatchKindId = (typeof BATCH_KINDS)[number];
export const isBatchKind = (k: string): k is BatchKindId => (BATCH_KINDS as readonly string[]).includes(k);

/** The key that names an item in a kind's export (the drain's `idKey`). */
const ID_KEY: Readonly<Record<BatchKindId, string>> = { "record-briefs": "id", "question-answers": "subject_ref", "needs-search": "need_id", "forward-events": "id", "theme-briefs": "theme_id", "screen-verdicts": "census_id", "ledger-verdicts": "candidate_id" };
export const DEFAULT_PART_CHARS = 3_000_000;
export interface ExportInput { outDir?: string; limit?: number; charBudget?: number; ids?: readonly string[]; mode?: string; runId?: string; repoRoot?: string }
export interface ExportOpts { limit: number; mode: string; ids?: readonly string[]; charBudget?: number }

const exporterOf = (kind: BatchKindId, deps: BatchDeps): ((o: ExportOpts) => Promise<BatchExport>) => {
  const budget = (o: ExportOpts) => (o.charBudget ? { charBudget: o.charBudget } : {});
  switch (kind) {
    case "record-briefs": return recordBriefsExporter(deps.sb, deps.now);
    case "question-answers": return (o) => questionExporter(deps.sb, budget(o))(o);
    case "needs-search": return needsExporter(deps.sb);
    case "forward-events": return forwardEventsExporter(deps.sb, deps.now);
    case "theme-briefs": return (o) => themeBriefsExporter(deps.sb, budget(o))(o);
    case "screen-verdicts": return screenVerdictsExporter(deps.sb);
    case "ledger-verdicts": return ledgerVerdictsExporter(deps);
  }
};
const DEFAULT_LIMIT: Readonly<Record<BatchKindId, number>> = { "record-briefs": 40, "question-answers": 100, "needs-search": 100, "forward-events": 100, "theme-briefs": 15, "screen-verdicts": 60, "ledger-verdicts": 100 };

/** The exporters the judgement drain takes (`DrainDeps.exporters`), keyed by the drain's kind ids: the drain's `screen-verdict` is this kit's `screen-verdicts`. */
export function drainExporters(deps: BatchDeps): Record<string, Exporter> {
  const e = (k: BatchKindId): Exporter => (o) => exporterOf(k, deps)({ ...o });
  return { "record-briefs": e("record-briefs"), "question-answers": e("question-answers"), "needs-search": e("needs-search"), "theme-briefs": e("theme-briefs"), "ledger-verdicts": e("ledger-verdicts"), "screen-verdict": e("screen-verdicts") };
}

/** Group items into numbered parts so no part's size exceeds `budget`, in input order. An item over the budget on its own goes alone and is flagged oversize (it is exported whole, never cut). Pure. */
export function chunkByCharBudget<T>(items: readonly T[], budget: number): { part: number; items: T[]; oversize?: true }[] {
  const parts: { items: T[]; oversize?: true }[] = [];
  let cur: T[] = [];
  let size = 0;
  const flush = () => {
    if (cur.length) parts.push({ items: cur });
    cur = [];
    size = 0;
  };
  for (const it of items) {
    const n = JSON.stringify(it).length;
    if (n > budget) {
      flush();
      parts.push({ items: [it], oversize: true });
    } else {
      if (cur.length && size + n > budget) flush();
      cur.push(it);
      size += n;
    }
  }
  flush();
  return parts.map((p, i) => ({ part: i + 1, ...p }));
}

/** The directory an export may write to: absolute-resolved and OUTSIDE the repository (a bundle holds pool text, which never belongs in the tree). */
export function scratchDir(kind: string, input: ExportInput): string {
  const root = resolve(input.repoRoot ?? process.cwd());
  const out = resolve(input.outDir ?? join(tmpdir(), "caros-batches", `${kind}-${input.runId ?? "export"}`));
  const rel = relative(root, out);
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error(`export refused: ${out} is inside the repository (${root}); an export goes to a scratch directory`);
  return out;
}

/** Export a kind: the exporter's items to numbered part files under the scratch directory. The result carries the exported ids and the part paths (never the pool text) for the queue. */
export async function exportBatch(kind: string, deps: BatchDeps, input: ExportInput = {}): Promise<RunResult> {
  if (!isBatchKind(kind)) return runResult("failed", { refused: 1 }, [`unknown batch kind "${kind}" (kinds: ${BATCH_KINDS.join(", ")})`]);
  let dir: string;
  try {
    dir = scratchDir(kind, input);
  } catch (e) {
    return runResult("failed", { refused: 1 }, [(e as Error).message]);
  }
  const res = await exporterOf(kind, deps)({ limit: input.limit ?? DEFAULT_LIMIT[kind], mode: input.mode ?? "pending", ...(input.ids ? { ids: input.ids } : {}), ...(input.charBudget ? { charBudget: input.charBudget } : {}) });
  if (!res.ok) return runResult("failed", { refused: 1 }, [`${kind}: export failed: ${res.error ?? "unknown"}`]);
  const parts = chunkByCharBudget(res.items, input.charBudget ?? DEFAULT_PART_CHARS);
  const paths: string[] = [];
  await mkdir(dir, { recursive: true });
  for (const p of parts) {
    const path = join(dir, `${kind}-export-part${p.part}.json`);
    await writeFile(path, `${JSON.stringify({ kind, part: p.part, parts: parts.length, generated_at: deps.now().toISOString(), ...(p.oversize ? { oversize: true } : {}), summary: res.summary ?? null, residue: res.residue ?? [], items: p.items }, null, 2)}\n`, "utf8");
    paths.push(path);
  }
  if (!parts.length) {
    const path = join(dir, `${kind}-export-part1.json`);
    await writeFile(path, `${JSON.stringify({ kind, part: 1, parts: 1, generated_at: deps.now().toISOString(), summary: res.summary ?? null, residue: res.residue ?? [], items: [] }, null, 2)}\n`, "utf8");
    paths.push(path);
  }
  const key = ID_KEY[kind];
  const ids = res.items.map((i) => String((i as Obj)[key] ?? "")).filter(Boolean);
  return { ...runResult("ok", { exported: res.items.length, parts: paths.length, residue: res.residue?.length ?? 0 }, [`${kind}: ${res.items.length} item(s) exported to ${paths.length} part file(s) under ${dir}`]), data: { ids: { exported_ids: ids, parts: paths }, summary: res.summary ?? null } };
}

const SPECS: Readonly<Record<string, (o: ApplyOpts) => EntrySpec<never, never>>> = {
  "record-briefs": (o) => recordBriefsSpec(o) as never,
  "question-answers": () => questionAnswersSpec as never,
  "needs-search": () => needsSearchSpec as never,
  "forward-events": () => forwardEventsSpec as never,
  "theme-briefs": () => themeBriefsSpec as never,
};
/** Validate a batch file against live material already loaded (`live` is what the kind's loader returns). Pure. A kind with no entry-by-entry validator (the two verdict files) has its own reader. */
export function validateBatch(kind: string, file: unknown, live: unknown): Verdict<unknown> {
  const spec = SPECS[kind]?.({ dry: true });
  if (!spec) throw new Error(`validateBatch: "${kind}" has no entry validator (kinds: ${Object.keys(SPECS).join(", ")})`);
  return validateEntries(spec as EntrySpec<unknown, unknown>, file, live);
}

/**
 * Apply a batch: `input.content` is the batch file's text (JSON; a markdown theme brief is `format: "md"`), `input.options` the kind's options (allowBriefOverwrite, ioBudgetMb, window). It never writes in a dry run, and it
 * records nothing itself: the run frame writes the ledger row from the result.
 */
export async function applyBatch(kind: string, deps: BatchDeps, input: { content: string; format?: "json" | "md"; dry: boolean; runId?: string; options?: Obj }): Promise<RunResult> {
  if (!isBatchKind(kind)) return runResult("failed", { refused: 1 }, [`refused: unknown batch kind "${kind}" (kinds: ${BATCH_KINDS.join(", ")})`]);
  const o = { ...(input.options ?? {}), dry: input.dry, ...(input.runId ? { runId: input.runId } : {}) } as ApplyOpts & Obj;
  if (kind === "theme-briefs") return applyThemeBriefs(deps, { content: input.content, ...(input.format ? { format: input.format } : {}) }, o);
  let file: unknown;
  try {
    file = JSON.parse(input.content);
  } catch (e) {
    return runResult("failed", { refused: 1 }, [`${kind} batch is not JSON: ${(e as Error).message}`]);
  }
  switch (kind) {
    case "record-briefs": return applyRecordBriefs(deps, file, o);
    case "question-answers": return applyQuestionAnswers(deps, file, o);
    case "needs-search": return applyNeedsSearch(deps, file, o);
    case "forward-events": return applyForwardEvents(deps, file, o);
    case "screen-verdicts": return applyScreenVerdicts(deps, file, o);
    case "ledger-verdicts": return applyLedgerVerdicts(deps, file, o);
  }
}
