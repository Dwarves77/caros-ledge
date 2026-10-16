// Ported from old_repo/scripts/turns/emit-live-smoke-artifact.mjs (lines 20-129)
// The live-smoke landing: a smoke report (the parity job's capture, until P2-15 adds the live checks) becomes one `live-smoke` row through the one recorder.
import type { Db } from "@/core/db";

import { newRunId, recordRun, type RunRow } from "./record";

export interface SmokeFinding {
  severity: "fail" | "warn" | string;
  invariant: string;
  url: string;
  viewport?: number | string;
  text?: string;
}
export interface SmokeReport {
  baseUrl?: string;
  findings: SmokeFinding[];
  pagesVisited: { url: string; viewport?: number | string }[];
  holds?: { invariant: string; key?: string; reason?: string }[];
}

/** One row from a report: success when no finding failed, failed otherwise; a missing or unreadable report is a failed row that says so. */
export function smokeRow(report: SmokeReport | null, o: { now: Date; startedAt?: Date; error?: string | null; codeSha: string | null; githubRunId: string | null; rootRunId?: string }): RunRow {
  const id = newRunId();
  const fails = report?.findings.filter((f) => f.severity === "fail") ?? [];
  const byInvariant: Record<string, number> = {};
  for (const f of fails) byInvariant[f.invariant] = (byInvariant[f.invariant] ?? 0) + 1;
  const ok = !!report && fails.length === 0;
  const counts = { pages_visited: report?.pagesVisited.length ?? 0, failures: fails.length, warnings: report?.findings.filter((f) => f.severity === "warn").length ?? 0, holds: report?.holds?.length ?? 0 };
  return {
    id, family: "live-smoke", root_run_id: o.rootRunId ?? id, upstream_run_id: null, trigger: "dispatch", mode: null, forced_dry: false, outcome: ok ? "success" : "failed",
    reason: ok ? null : (o.error ?? `${fails.length} failed invariant finding(s)`), inputs: { target: report?.baseUrl ?? null },
    outputs: { counts, failures_by_invariant: byInvariant, first_failures: fails.slice(0, 5).map((f) => `${f.invariant} ${f.url}: ${String(f.text ?? "").slice(0, 120)}`) },
    error: ok ? null : (o.error ?? fails[0]?.invariant ?? "failed"), code_sha: o.codeSha, github_run_id: o.githubRunId, started_at: (o.startedAt ?? o.now).toISOString(), finished_at: o.now.toISOString(),
  };
}

export async function recordLiveSmoke(sb: Db | null, report: SmokeReport | null, o: Parameters<typeof smokeRow>[1]): Promise<{ id: string | null; error: string | null }> {
  return recordRun(sb, smokeRow(report, o));
}
