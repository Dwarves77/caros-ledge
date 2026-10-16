// Ported from old_repo/scripts/mint/lib/screen-verdict.mjs (lines 1-24)
// Screen verdicts (IMP-039): the relevance screen's ambiguous holds go out as a queue (the drain's exporter, called, never copied), a session rules each (on_vertical, off_vertical or ambiguous, with the basis it cites), the
// verdicts land in screen_verdicts through the drain's one writer, every row is read back, and the held census rows the verdicts RULE are re-admitted to would_mint so the mint re-screens them with the reviewed verdict
// (rule 17). A verdict that stays ambiguous re-admits nothing. Only the named census ids are reopened (INV-028: never a blanket reopen).
import type { Db } from "@/core/db";
import { applyScreenVerdictBatch, screenVerdictExporter } from "@/features/drain";
import { isReopenTarget } from "@/features/mint/apply";
import { runResult } from "@/core/types/run-result";
import type { RunResult } from "@/core/types/run-result";
import { rowsByIds } from "@/core/db";

import { type ApplyOpts, type BatchDeps, type BatchExport } from "../../kit/session-batch";

export const screenVerdictsExporter = (sb: Db) => async (o: { limit: number; mode: string }): Promise<BatchExport> => screenVerdictExporter(sb)(o);

/** Re-admit the held ambiguous rows the verdicts rule (keeping the held evidence in the notes). A failed write is reported per row. */
export async function reopenRuledHolds(sb: Db, ids: readonly string[], nowIso: string): Promise<{ matched: number; written: number; failures: string[] }> {
  const rows = await rowsByIds<{ id: string; dryrun_disposition: string | null; hold_reason: string | null; notes: string | null }>(sb, "census_worklist", "id, dryrun_disposition, hold_reason, notes", ids);
  const targets = rows.filter((r) => isReopenTarget(r, "screen:ambiguous"));
  const failures: string[] = [];
  let written = 0;
  for (const t of targets) {
    const marker = `[reopened ${nowIso}] a reviewed screen verdict now rules this row; re-admitted to would_mint, not re-validated here.`;
    const { error } = await sb.from("census_worklist").update({ dryrun_disposition: "would_mint", hold_reason: null, notes: t.notes ? `${t.notes}\n\n${marker}` : marker }).eq("id", t.id).eq("dryrun_disposition", "hold");
    if (error) failures.push(`${t.id}: ${error.message}`);
    else written += 1;
  }
  return { matched: targets.length, written, failures };
}

/** Apply a screen-verdict batch (`{ verdicts: [{ census_id, verdict, basis, reviewer }] }`): validate row by row, write what is new, read back, re-admit the ruled holds. A verdict already stored as written is "already applied": a re-apply writes nothing (INV-210). */
export async function applyScreenVerdicts(deps: BatchDeps, file: unknown, o: ApplyOpts): Promise<RunResult> {
  const batch = (file ?? {}) as { verdicts?: Array<Record<string, unknown>> };
  if (!Array.isArray(batch.verdicts)) return runResult("failed", { refused: 1 }, ["screen-verdicts: the batch has no verdicts array"]);
  const ids = batch.verdicts.map((v) => String(v.census_id));
  const held = new Map((await rowsByIds<{ census_id: string; verdict: string; basis: string; reviewer: string | null }>(deps.sb, "screen_verdicts", "census_id, verdict, basis, reviewer", ids, "census_id", "census_id")).map((x) => [x.census_id, x]));
  const same = (v: Record<string, unknown>): boolean => {
    const h = held.get(String(v.census_id));
    return !!h && h.verdict === v.verdict && h.basis === String(v.basis ?? "").trim() && (h.reviewer ?? null) === (typeof v.reviewer === "string" ? v.reviewer : null);
  };
  const fresh = batch.verdicts.filter((v) => !same(v));
  const r = await applyScreenVerdictBatch({ sb: deps.sb, now: deps.now }, { verdicts: fresh }, { dry: o.dry });
  const counts: Record<string, number> = { entries: batch.verdicts.length, planned: r.planned, already_applied: batch.verdicts.length - fresh.length, applied: r.written, refused: r.refused.length, read_back_failures: 0, reopened: 0 };
  const notes = [...r.refused];
  if (o.dry) return runResult(r.refused.length ? "partial" : "ok", counts, notes);
  const back = new Map((await rowsByIds<{ census_id: string; verdict: string }>(deps.sb, "screen_verdicts", "census_id, verdict", ids, "census_id", "census_id")).map((x) => [x.census_id, x.verdict]));
  for (const v of fresh) if (back.has(String(v.census_id)) && back.get(String(v.census_id)) !== v.verdict) {
    counts.read_back_failures = (counts.read_back_failures as number) + 1;
    notes.push(`screen_verdicts ${String(v.census_id)}: read-back failed: the stored verdict is ${back.get(String(v.census_id))}`);
  }
  // The rows reopened are the ones the STORED verdicts rule (a refused entry never reaches the table, so it never reopens anything).
  const ruled = [...back].filter(([, v]) => v === "on_vertical" || v === "off_vertical").map(([id]) => id);
  const reopen = ruled.length ? await reopenRuledHolds(deps.sb, ruled, deps.now().toISOString()) : { written: 0, failures: [] as string[] };
  counts.reopened = reopen.written;
  notes.push(...reopen.failures.map((f) => `reopen failed: ${f}`));
  return runResult(r.refused.length || counts.read_back_failures || reopen.failures.length ? "partial" : "ok", counts, notes);
}
