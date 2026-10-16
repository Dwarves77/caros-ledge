// Ported from old_repo/scripts/producers/lib/producer-summary.mjs (lines 1-60)
// Ported from old_repo/scripts/producers/emit-producers-artifact.mjs (lines 15-91)
// A producer's own run summary (one JSON file per producer) and the pure fold of those summaries into the producers family's artifact body.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ProducerSummary {
  producer: string;
  status: "ok" | "failed";
  rows_changed: number;
  edges_authored: number | null;
  reason: string | null;
  counts: Record<string, number>;
  written_at: string;
}
export type SummaryArgs = Omit<ProducerSummary, "written_at" | "reason" | "counts"> & { reason?: string | null; counts?: Record<string, number> };

/** Write `<dir>/<producer>.json`. A no-op (returns null, writes nothing) when no directory is configured. The clock is the caller's. */
export function writeProducerSummary(a: SummaryArgs, o: { dir?: string | null | undefined; now?: Date | undefined } = {}): string | null {
  if (!o.dir) return null;
  if (typeof a.producer !== "string" || !a.producer.trim()) throw new Error("writeProducerSummary: producer must be a non-empty string");
  if (a.status !== "ok" && a.status !== "failed") throw new Error(`writeProducerSummary: status must be ok or failed (got ${JSON.stringify(a.status)})`);
  if (!Number.isFinite(a.rows_changed)) throw new Error(`writeProducerSummary: rows_changed must be a finite number (got ${JSON.stringify(a.rows_changed)})`);
  if (a.edges_authored !== null && !Number.isFinite(a.edges_authored)) throw new Error(`writeProducerSummary: edges_authored must be a finite number or null (got ${JSON.stringify(a.edges_authored)})`);
  const summary: ProducerSummary = { producer: a.producer, status: a.status, rows_changed: a.rows_changed, edges_authored: a.edges_authored, reason: a.status === "failed" ? (a.reason ?? "no reason recorded") : null, counts: a.counts ?? {}, written_at: (o.now ?? new Date()).toISOString() };
  const dir = resolve(o.dir);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${a.producer}.json`);
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return out;
}

/** Fold the summaries of one firing into the family artifact body (per item, metrics, defects). Pure; the harness adds the header and writes the file. */
export function foldProducerSummaries(summaries: readonly ProducerSummary[]) {
  const failedOnes = summaries.filter((s) => s.status === "failed");
  const sum = (f: (s: ProducerSummary) => number | null) => summaries.reduce((acc, s) => acc + (f(s) ?? 0), 0);
  return {
    inputs_ref: summaries.map((s) => s.producer),
    per_item: summaries.map((s) => ({
      id: s.producer,
      outcome: s.status === "failed" ? "failed" : "clean",
      verdict: s.status === "failed" ? s.reason || "no reason recorded" : `rows_changed=${s.rows_changed} edges_authored=${JSON.stringify(s.edges_authored)}`,
      evidence_refs: [] as string[],
      error: s.status === "failed" ? JSON.stringify({ reason: s.reason, counts: s.counts }) : null,
    })),
    metrics: { producers_reporting: summaries.length, producers_failed: failedOnes.length, rows_changed_total: sum((s) => s.rows_changed), edges_authored_total: sum((s) => s.edges_authored) },
    defects_found: failedOnes.length
      ? [{ description: `${failedOnes.length} of ${summaries.length} producer(s) reported status "failed" this run`, root_cause: failedOnes.map((s) => `${s.producer}: ${s.reason}`).join(" | "), fix_ref: null }]
      : [],
    proposer_notes: summaries.length ? "Folded from the producers' own summaries." : "This dispatch recorded zero producer summaries (no apply step ran, or no summary directory was set); recorded anyway so the family's history shows every firing.",
  };
}
