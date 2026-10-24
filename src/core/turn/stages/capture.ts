// Ported from old_repo/scripts/turns/run-fetch-drain.mjs (lines 92-207)
// Ported from old_repo/scripts/turns/run-fetch-drain.mjs (lines 268-391)
// Stage 4, capture: the sources the change stage found changed are queued (one open row per source), then the capture worker drains the queue and stores each whole document.
// The worker reads no gate of its own: this stage reads the gate first, and the worker call carries a timeout.
import { capture } from "@/core/fetch";
import { storageMaxChars } from "@/core/fetch/policy";
import { storeCapture, type Db as StoreDb } from "@/core/fetch/store-capture";
import type { FamilyCall } from "@/core/harness";
import { registerAndRate } from "@/core/sources/register";
import type { RunResult } from "@/core/types/run-result";
import { runResult } from "@/core/types/run-result";

import type { BuiltDeps } from "../wiring";

const CAPTURE_MAX_LIMIT = 10;
interface Report {
  queue_id: string;
  source_id: string;
  outcome: string;
  capture_id: string | null;
  detail: string | null;
}

function planCapture(input: Record<string, unknown>, upstreamIds: readonly string[]): { limit: number; sourceIds: string[] } {
  const own = Array.isArray(input.sourceIds) ? input.sourceIds.filter((x): x is string => typeof x === "string") : [];
  return { limit: Math.min(typeof input.limit === "number" ? Math.floor(input.limit) : 3, CAPTURE_MAX_LIMIT), sourceIds: [...new Set([...upstreamIds, ...own])] };
}

/** Roll the worker's reports into the stage result: a failed capture is counted and named; nothing queued is ok with nothing captured. Pure. */
export function shapeCapture(reports: readonly Report[], queued: number): RunResult {
  const by = (o: string) => reports.filter((r) => r.outcome === o);
  const failed = by("failed").length;
  const counts = { queued, processed: reports.length, captured: by("captured").length, duplicate_skipped: by("duplicate_skipped").length, requeued: by("requeued").length, failed };
  const outcome = failed === 0 ? "ok" : failed < reports.length ? "partial" : "failed";
  return { ...runResult(outcome, counts, by("failed").map((r) => `${r.source_id}: ${r.detail ?? "failed"}`)), data: { ids: { capture_ids: by("captured").map((r) => r.capture_id).filter((x): x is string => !!x), captured_source_ids: by("captured").map((r) => r.source_id) } } };
}

/** Rule 17 for a reviewed rows file: each cited page is rated through the class table, captured by the one capture path and stored by the one writer, so the producer's quote check (acceptStoredQuote) finds the capture it verifies against. Never fetches a page twice for one hash. */
export async function captureCited(d: BuiltDeps, cited: readonly { url: string; title: string }[]): Promise<RunResult> {
  const counts = { cited: cited.length, captured: 0, unchanged: 0, failed: 0 };
  const notes: string[] = [];
  for (const { url, title } of cited) {
    const rated = await registerAndRate(d.sb, url, { name: title });
    const got = "source_id" in rated ? await capture(url, {}, d.fetch) : null;
    if (!got?.usable || !got.text || !("source_id" in rated)) {
      counts.failed += 1;
      notes.push(`${url}: ${"source_id" in rated ? (got?.holdReason ?? "no usable capture") : `not registered (${rated.status})`}`);
      continue;
    }
    const s = await storeCapture(d.sb as unknown as StoreDb, { sourceId: rated.source_id, sourceUrl: url, sourceName: title, finalUrl: url, text: got.text, title: got.title, httpStatus: got.status ?? 200, channel: got.channel ?? "direct", numberLocale: null, itemId: null, itemIds: [], declaredTransforms: [{ declared_transform: "rows-file-citation", at: d.now().toISOString() }], ceilingBind: null, ceiling: storageMaxChars(d.env) }, () => d.now().getTime(), d.now().getTime());
    if (s.outcome === "failed") notes.push(`${url}: ${s.detail}`);
    counts[s.outcome === "captured" ? "captured" : s.outcome === "unchanged" ? "unchanged" : "failed"] += 1;
  }
  return runResult(counts.failed ? (counts.failed < cited.length ? "partial" : "failed") : "ok", counts, notes);
}

export async function runCapture(call: FamilyCall, d: BuiltDeps): Promise<RunResult> {
  const plan = planCapture(call.input, call.upstream?.ids.changed_source_ids ?? []);
  if (call.dry) {
    const q = await d.sb.from("pending_first_fetch").select("id", { count: "exact", head: true }).eq("status", "queued");
    if (q.error) return runResult("failed", {}, [`queue read failed: ${q.error.message}`]);
    return runResult("ok", { to_queue: plan.sourceIds.length, queued_rows: q.count ?? 0 }, ["dry: nothing queued, nothing fetched"]);
  }
  if (!(await d.gate.refresh())) return runResult("failed", { refused: 1 }, ["fetch gate closed (the scrape cadence is off, or the emergency stop is set): the capture worker is not called"]);
  let queued = 0;
  if (plan.sourceIds.length) {
    const open = await d.sb.from("pending_first_fetch").select("source_id").in("source_id", plan.sourceIds).in("status", ["queued", "fetching"]);
    if (open.error) return runResult("failed", {}, [`open queue read failed: ${open.error.message}`]);
    const have = new Set(((open.data ?? []) as { source_id: string }[]).map((r) => r.source_id));
    const fresh = plan.sourceIds.filter((id) => !have.has(id));
    if (fresh.length) {
      const ins = await d.sb.from("pending_first_fetch").insert(fresh.map((source_id) => ({ source_id, status: "queued" })));
      if (ins.error) return runResult("failed", {}, [`queue insert failed: ${ins.error.message}`]);
      queued = fresh.length;
    }
  }
  const res = await d.worker({ limit: plan.limit });
  if (res.status !== 200) return runResult("failed", { queued }, [`capture worker answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`]);
  return shapeCapture((res.body.results ?? []) as Report[], queued);
}
