// Ported from old_repo/supabase/functions/capture-worker/index.ts (lines 222-256)
// Ported from old_repo/supabase/functions/capture-worker/index.ts (lines 259-581)
// Ported from old_repo/supabase/functions/capture-worker/index.ts (lines 589-614)
// The capture contract, in five clauses (ADR-016):
//   1. A capture is the FULL decoded body of one document, fetched through the shared policy (src/core/fetch/policy.ts), with every transform declared on the run.
//   2. A non-200, an unsupported type, an error page, a thin body or an unreadable PDF is a recorded failure and is never stored as a capture (INV-184).
//   3. The queue claim is atomic and one open row exists per source; a transient outcome requeues up to MAX_ATTEMPTS and only a permanent one terminalises (INV-185).
//   4. The only ceiling is the pathological-page sanity bound STORAGE_MAX_CHARS, and binding it is LOUD: a declared transform and a coverage_gap flag, never a quiet trim.
//   5. Every outcome is read back: a failed claim, idempotency read or write is reported and requeues, never read as "already claimed" or "no duplicate".
import { fetchDocument, MAX_ATTEMPTS, storageMaxChars, type FetchOutcome } from "../../../src/core/fetch/policy.ts";

export type Reply = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
export type Query = Reply & { [method: string]: (...args: unknown[]) => Query };
export interface Db {
  from(table: string): Query;
}
export interface QueueRow {
  id: string;
  source_id: string;
  status: string;
  attempt_count: number;
}
export interface WorkerDeps {
  db: Db;
  fetchImpl?: typeof fetch;
  extractPdf?: (bytes: Uint8Array) => Promise<{ text: string; pages: number | null; title: string | null }>;
  env: Record<string, string | undefined>;
  now: () => number;
}
export interface CaptureReport {
  queue_id: string;
  source_id: string;
  outcome: "captured" | "duplicate_skipped" | "requeued" | "failed" | "skipped";
  http_status: number | null;
  chars: number | null;
  capture_id: string | null;
  run_id: string | null;
  intelligence_item_id: string | null;
  content_type: string | null;
  nulls_removed: number;
  pdf_pages: number | null;
  pdf_bytes: number | null;
  detail: string | null;
  url: string | null;
  storage_ceiling_bind?: { collected: number; fullLength: number };
}

/** A service-role bearer is the only caller: the function is invoked by the dispatcher or the capture_worker_fetch rpc with the service key. Compared in constant time. */
export function isServiceRoleRequest(authorization: string | null, serviceKey: string | undefined): boolean {
  if (!serviceKey || !authorization?.startsWith("Bearer ")) return false;
  const a = new TextEncoder().encode(authorization.slice(7));
  const b = new TextEncoder().encode(serviceKey);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const err = (r: { error: { message: string } | null }) => (r.error ? r.error.message : null);

async function record(deps: WorkerDeps, table: string, op: "insert" | "update", payload: Record<string, unknown>, eq?: [string, unknown]): Promise<string | null> {
  const q = deps.db.from(table);
  const base = op === "insert" ? q.insert(payload) : q.update(payload);
  return err(await (eq ? base.eq(eq[0], eq[1]) : base));
}
/** Requeue a TRANSIENT failure (status stays queued so the one-open-row index never wedges the source). No agent_runs row: a retry is not a capture outcome. */
async function recordRetry(deps: WorkerDeps, row: QueueRow, report: CaptureReport): Promise<void> {
  const e = await record(deps, "pending_first_fetch", "update", { status: "queued", last_error_text: `[transient, will retry] ${report.detail}` }, ["id", row.id]);
  report.outcome = "requeued";
  if (e) report.detail = `${report.detail}; requeue write failed: ${e}`;
}
async function recordFailure(deps: WorkerDeps, row: QueueRow, src: { id: string; url: string | null }, report: CaptureReport, runStart: number): Promise<void> {
  const at = new Date(deps.now()).toISOString();
  const e1 = await record(deps, "agent_runs", "insert", { source_id: src.id, source_url: src.url, fetch_method: "capture-worker", status: "error", fetch_status: report.http_status, ended_at: at, duration_ms: deps.now() - runStart, errors: [{ detail: report.detail, content_type: report.content_type, at }] });
  const e2 = await record(deps, "pending_first_fetch", "update", { status: "error", last_error_text: report.detail }, ["id", row.id]);
  report.outcome = "failed";
  const writeErr = [e1 && `agent_runs: ${e1}`, e2 && `queue: ${e2}`].filter(Boolean).join("; ");
  if (writeErr) report.detail = `${report.detail}; failure record incomplete (${writeErr})`;
}

/** Process one queue row end to end under the contract above. Never throws: every outcome is on the report. */
export async function processRow(deps: WorkerDeps, row: QueueRow): Promise<CaptureReport> {
  const { db } = deps;
  const report: CaptureReport = { queue_id: row.id, source_id: row.source_id, outcome: "failed", http_status: null, chars: null, capture_id: null, run_id: null, intelligence_item_id: null, content_type: null, nulls_removed: 0, pdf_pages: null, pdf_bytes: null, detail: null, url: null };
  const srcRes = await db.from("sources").select("id, url, name").eq("id", row.source_id).single();
  const src = srcRes.data as { id: string; url: string; name: string } | null;
  if (srcRes.error || !src?.url) {
    report.detail = srcRes.error ? `source read failed: ${srcRes.error.message}` : "source row or url missing";
    await recordFailure(deps, row, { id: row.source_id, url: null }, report, deps.now());
    return report;
  }
  report.url = src.url;

  // Item scoping: exactly one live item on the source links the capture, else it is pool-scoped. A read error requeues; scope is never guessed.
  const itemsRes = await db.from("intelligence_items").select("id").eq("source_id", src.id).eq("is_archived", false).limit(2);
  if (itemsRes.error) {
    report.detail = `item-scope read failed: ${itemsRes.error.message}`;
    await recordRetry(deps, row, report);
    return report;
  }
  const items = itemsRes.data as Array<{ id: string }> | null;
  const itemId = items && items.length === 1 ? (items[0]?.id ?? null) : null;
  report.intelligence_item_id = itemId;

  // Atomic claim: queued or error to fetching only if this call wins the row. A claim error is reported; it is never read as "already claimed".
  const claimRes = await db.from("pending_first_fetch").update({ attempt_count: row.attempt_count + 1, last_attempt_at: new Date(deps.now()).toISOString(), status: "fetching" }).eq("id", row.id).in("status", ["queued", "error"]).select("id");
  if (claimRes.error) {
    report.outcome = "failed";
    report.detail = `claim write failed: ${claimRes.error.message}`;
    return report;
  }
  const claimed = claimRes.data as unknown[] | null;
  if (!claimed || claimed.length === 0) {
    report.outcome = "skipped";
    report.detail = "row already claimed by another run";
    return report;
  }
  const attempt = row.attempt_count + 1;
  const runStart = deps.now();
  const ceiling = storageMaxChars(deps.env);
  const doc: FetchOutcome = await fetchDocument(src.url, { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.extractPdf ? { extractPdf: deps.extractPdf } : {}), now: deps.now, maxChars: ceiling });
  if (!doc.ok) {
    report.http_status = doc.status;
    report.content_type = doc.contentType;
    report.pdf_bytes = doc.pdfBytes;
    report.detail = doc.detail;
    if (doc.transient && attempt < MAX_ATTEMPTS) await recordRetry(deps, row, report);
    else await recordFailure(deps, row, src, report, runStart);
    return report;
  }
  report.http_status = doc.status;
  report.content_type = doc.contentType;
  report.chars = doc.text.length;
  report.nulls_removed = doc.nullsRemoved;
  report.pdf_pages = doc.pdfPages;
  report.pdf_bytes = doc.pdfBytes;

  // Idempotent per final URL. A read error requeues: it is never read as "no duplicate" and proceeded to insert.
  const dup = await db.from("agent_run_searches").select("id").eq("result_url", doc.finalUrl).eq("search_query", "capture-worker:first-fetch").limit(1);
  if (dup.error) {
    report.detail = `idempotency read failed: ${dup.error.message}`;
    await recordRetry(deps, row, report);
    return report;
  }
  const existing = dup.data as Array<{ id: string }> | null;
  if (existing && existing.length > 0) {
    report.outcome = "duplicate_skipped";
    report.capture_id = existing[0]?.id ?? null;
    report.detail = "worker capture already exists for this final URL";
    const e = await record(deps, "pending_first_fetch", "update", { status: "done", last_error_text: null }, ["id", row.id]);
    if (e) report.detail = `${report.detail}; queue write failed: ${e}`;
    return report;
  }

  const bind = doc.ceilingBind;
  if (bind) report.storage_ceiling_bind = bind;
  const runIns = await db.from("agent_runs").insert({ source_id: src.id, source_url: src.url, fetch_method: "capture-worker", status: "success", fetch_status: doc.status, fetch_html_bytes: doc.text.length, intelligence_item_id: itemId, errors: doc.declaredTransforms, ended_at: new Date(deps.now()).toISOString(), duration_ms: deps.now() - runStart }).select("id").single();
  const run = runIns.data as { id: string } | null;
  if (runIns.error || !run) {
    report.detail = `agent_runs insert failed: ${runIns.error?.message ?? "no row"}`;
    await recordRetry(deps, row, report);
    return report;
  }
  report.run_id = run.id;
  const capIns = await db.from("agent_run_searches").insert({ agent_run_id: run.id, intelligence_item_id: itemId, search_query: "capture-worker:first-fetch", result_url: doc.finalUrl, result_title: doc.title ?? src.name, result_index: 0, result_content: doc.text, searched_at: new Date(deps.now()).toISOString() }).select("id").single();
  const cap = capIns.data as { id: string } | null;
  if (capIns.error || !cap) {
    report.detail = `capture insert failed: ${capIns.error?.message ?? "no row"}`;
    await record(deps, "agent_runs", "update", { status: "error" }, ["id", run.id]);
    await recordRetry(deps, row, report);
    return report;
  }
  report.capture_id = cap.id;
  // Filed only after the capture landed, so a flag never points at a row that failed to store. The ceiling bind is LOUD: this flag is its signal.
  let flagNote = "";
  if (bind) {
    const fe = await record(deps, "integrity_flags", "insert", {
      category: "coverage_gap",
      subject_type: itemId ? "item" : "source",
      subject_ref: itemId ?? src.id,
      description: `capture-worker hit the ADR-016 storage ceiling on ${doc.finalUrl}: collected ${bind.collected} of ${bind.fullLength} chars (cap ${ceiling}). The stored capture is the head of the document; the tail was not captured, so any grounding off this row is incomplete.`,
      recommended_actions: [
        { action: "Assess whether the tail carries obligations", rationale: "ADR-016: relevance is not pre-identifiable; a qualifying clause can sit anywhere in the document." },
        { action: "Re-capture in parts or raise STORAGE_MAX_CHARS for this source", rationale: "The ceiling is a pathological-page sanity bound, not an operating cap." },
      ],
      created_by: "capture-worker",
    });
    if (fe) flagNote = `; ceiling flag insert FAILED: ${fe}`;
  }
  const done = await record(deps, "pending_first_fetch", "update", { status: "done", last_error_text: null }, ["id", row.id]);
  report.outcome = "captured";
  report.detail = `${doc.isPdf ? `pdf text layer stored (${doc.pdfPages} pages, declared transform)` : "stored verbatim"}, ${itemId ? "item-linked" : "pool-scoped"}${flagNote}${done ? `; queue write failed: ${done}` : ""}`;
  return report;
}

/** The queue select and the loop: the default drain takes queued rows only; an explicit replay may also take a row at 'error'. A queue read failure is a 500, never an empty drain. */
export async function drain(deps: WorkerDeps, input: { limit?: number; queue_ids?: string[] | null }): Promise<{ status: number; body: Record<string, unknown> }> {
  const limit = Math.min(Number(input.limit ?? 3), 10);
  const ids = Array.isArray(input.queue_ids) ? input.queue_ids : null;
  const base = deps.db.from("pending_first_fetch").select("id, source_id, status, attempt_count");
  const q = ids ? base.in("id", ids) : base.eq("status", "queued").order("queued_at").limit(limit);
  const { data, error } = await q;
  if (error) return { status: 500, body: { error: error.message } };
  const results: Array<CaptureReport | { queue_id: string; outcome: string; detail: string }> = [];
  for (const row of (data ?? []) as QueueRow[]) {
    if (row.status !== "queued" && !(ids && row.status === "error")) {
      results.push({ queue_id: row.id, outcome: "skipped", detail: `status=${row.status}, not queued` });
      continue;
    }
    results.push(await processRow(deps, row));
  }
  return { status: 200, body: { processed: results.length, results } };
}
