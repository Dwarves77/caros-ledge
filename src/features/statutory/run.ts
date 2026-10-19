// Ported from old_repo/scripts/propagation/write-statutory.mjs (lines 62-224)
// Ported from old_repo/scripts/propagation/validate-statutory-rows-file.mjs (lines 16-39)
// The statutory writer as a runtime function (no CLI, no exit code): validate the session-authored rows file, then write each row through the filing gate.
// Dry by default at the caller. Per-row refusals are counted and listed; an errored row makes the run partial. The harness record is the recorder's (P2-08).
import type { Db } from "@/core/db";
import type { RunResult } from "@/core/sources/run-result";

import { parseRow, validateRowsFile, verifyRowQuotes, writeOneRow, type StatutoryDeps } from "./rows";

export interface StatutoryRunDeps {
  sb: Db;
  now: () => Date;
  statutory: StatutoryDeps;
}

/** The violations of a rows file (the `validate` subcommand): empty means it is apply-ready. */
export const validateStatutoryRows = (file: unknown): string[] => validateRowsFile(file);

export async function statutoryRun(deps: StatutoryRunDeps, input: { dry: boolean; file: unknown }): Promise<RunResult<{ perItem: { id: string; outcome: string; detail: string | null }[] }>> {
  const violations = validateRowsFile(input.file);
  if (violations.length) return { counts: { violations: violations.length }, outcome: "failed", notes: violations.slice(0, 50), data: { perItem: [] } };
  const rows = (Array.isArray(input.file) ? input.file : (input.file as { rows: unknown[] }).rows) as unknown[];
  const counts: Record<string, number> = { rows: rows.length, written: 0, would_write: 0, skipped_already: 0, refused: 0, errored: 0 };
  const perItem: { id: string; outcome: string; detail: string | null }[] = [];
  const notes: string[] = [];
  const texts = new Map<string, string>();
  for (const [i, raw] of rows.entries()) {
    let parsed;
    try {
      parsed = parseRow(raw, i);
    } catch (e) {
      counts.refused = (counts.refused ?? 0) + 1;
      perItem.push({ id: `row[${i}]`, outcome: "refused-structural", detail: e instanceof Error ? e.message : String(e) });
      continue;
    }
    try {
      // A quote nobody checked against a stored capture is not an input: the row is refused with the reason, in dry runs too.
      const proof = await verifyRowQuotes(deps.sb, raw, deps.now(), texts);
      if (!proof.ok) {
        counts.refused = (counts.refused ?? 0) + 1;
        perItem.push({ id: parsed.shipKey, outcome: "refused-quote", detail: proof.reason });
        continue;
      }
      const out = await writeOneRow(deps.sb, parsed, deps.statutory, { apply: !input.dry, now: deps.now(), captureIds: proof.captureIds });
      const key = out.action === "written" ? "written" : out.action === "would-write" ? "would_write" : out.action === "skipped-already-computed" ? "skipped_already" : out.action === "errored" ? "errored" : "refused";
      counts[key] = (counts[key] ?? 0) + 1;
      perItem.push({ id: out.shipKey, outcome: out.action, detail: out.action === "refused-inadmissible" ? `${out.field}: ${out.reason}` : out.action === "errored" ? out.reason : "resultEur" in out ? `result=${out.resultEur} EUR` : null });
    } catch (e) {
      counts.errored = (counts.errored ?? 0) + 1;
      notes.push(`${parsed.shipKey}: ${e instanceof Error ? e.message : String(e)}`);
      perItem.push({ id: parsed.shipKey, outcome: "errored", detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return { counts, outcome: counts.errored ? "partial" : "ok", notes: input.dry ? [...notes, "dry: nothing written"] : notes, data: { perItem } };
}
