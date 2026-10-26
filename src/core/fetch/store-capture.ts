// Ported from old_repo/supabase/functions/capture-worker/index.ts (lines 259-581)
// The one place a capture is written, shared by the capture worker (Edge Function, Deno) and the runner-side collection runtime (Node), so a capture from the browser tier or a substitute publisher is stored exactly as a direct one.
// Import-free for that reason. The content hash is over the text with all whitespace collapsed (I1 of toText: a capture that keeps its paragraphs hashes as the flat capture always did, so no re-capture of an unchanged page is a new row). The idempotency key is (final URL, content hash): the same hash is `unchanged` and writes nothing; a different hash inserts a new capture row, which supersedes the old one by being newer.
// A fresh body also closes the open stale-snapshot flags of the items on the source; an unchanged body closes none.
export type Reply = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
/** The query-builder calls the worker makes, each named (an index signature reads as possibly undefined under noUncheckedIndexedAccess). */
export type Query = Reply & Record<"select" | "insert" | "update" | "eq" | "in" | "order" | "limit" | "single", (...args: unknown[]) => Query>;
export interface Db {
  from(table: string): Query;
}
const CAPTURE_QUERY = "capture-worker:first-fetch";
const STALE_FLAG_CREATOR = "stale_snapshot_content_changed";
export type CaptureChannel = "api" | "feed" | "sitemap" | "direct" | "browser" | "substitute";

export interface CaptureToStore {
  /** The source whose registry row owns the capture: the refusing source for its own channels, the publisher's row for a substitute. */
  sourceId: string;
  sourceUrl: string;
  sourceName: string;
  finalUrl: string;
  text: string;
  title: string | null;
  httpStatus: number;
  channel: CaptureChannel;
  /** The BCP-47 locale of the document (the publisher's declared locale, else what the document declares); null when neither is known, never a guess (migration 0080, number_locale). */
  numberLocale: string | null;
  itemId: string | null;
  /** Every live item of the source (up to the read limit), whose stale flags a fresh body closes. */
  itemIds: readonly string[];
  declaredTransforms: readonly Record<string, unknown>[];
  ceilingBind: { collected: number; fullLength: number } | null;
  ceiling: number;
}
export interface StoreOutcome {
  outcome: "captured" | "unchanged" | "failed";
  captureId: string | null;
  runId: string | null;
  contentHash: string | null;
  detail: string;
  retry: boolean;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const msg = (r: { error: { message: string } | null }): string | null => (r.error ? r.error.message : null);

/** Store one capture under the contract (ADR-016): a failed idempotency read, run insert or capture insert is reported and retried by the caller, never read as "no duplicate". */
export async function storeCapture(db: Db, c: CaptureToStore, nowMs: () => number, startedMs: number): Promise<StoreOutcome> {
  const fail = (detail: string, retry = true): StoreOutcome => ({ outcome: "failed", captureId: null, runId: null, contentHash: null, detail, retry });
  const hash = await sha256Hex(c.text.replace(/\s+/g, " "));
  const dup = (await db.from("agent_run_searches").select("id").eq("result_url", c.finalUrl).eq("search_query", CAPTURE_QUERY).eq("content_hash", hash).limit(1)) as { data: unknown; error: { message: string } | null };
  if (dup.error) return fail(`idempotency read failed: ${dup.error.message}`);
  const existing = dup.data as Array<{ id: string }> | null;
  if (existing && existing.length > 0) return { outcome: "unchanged", captureId: existing[0]?.id ?? null, runId: null, contentHash: hash, detail: "unchanged: a capture of this final URL with the same content hash already exists", retry: false };
  const at = new Date(nowMs()).toISOString();
  const runIns = (await db.from("agent_runs").insert({ source_id: c.sourceId, source_url: c.sourceUrl, fetch_method: "capture-worker", status: "success", fetch_status: c.httpStatus, fetch_html_bytes: c.text.length, intelligence_item_id: c.itemId, errors: c.declaredTransforms, ended_at: at, duration_ms: nowMs() - startedMs }).select("id").single()) as { data: unknown; error: { message: string } | null };
  const run = runIns.data as { id: string } | null;
  if (runIns.error || !run) return fail(`agent_runs insert failed: ${runIns.error?.message ?? "no row"}`);
  const capIns = (await db.from("agent_run_searches").insert({ agent_run_id: run.id, intelligence_item_id: c.itemId, search_query: CAPTURE_QUERY, result_url: c.finalUrl, result_title: c.title ?? c.sourceName, result_index: 0, result_content: c.text, searched_at: at, content_hash: hash, capture_channel: c.channel, number_locale: c.numberLocale }).select("id").single()) as { data: unknown; error: { message: string } | null };
  const cap = capIns.data as { id: string } | null;
  if (capIns.error || !cap) {
    await db.from("agent_runs").update({ status: "error" }).eq("id", run.id);
    return fail(`capture insert failed: ${capIns.error?.message ?? "no row"}`);
  }
  const notes: string[] = [];
  if (c.ceilingBind) {
    const fe = msg((await db.from("integrity_flags").insert({
      category: "coverage_gap",
      subject_type: c.itemId ? "item" : "source",
      subject_ref: c.itemId ?? c.sourceId,
      description: `capture-worker hit the ADR-016 storage ceiling on ${c.finalUrl}: collected ${c.ceilingBind.collected} of ${c.ceilingBind.fullLength} chars (cap ${c.ceiling}). The stored capture is the head of the document; the tail was not captured, so any grounding off this row is incomplete.`,
      recommended_actions: [
        { action: "Assess whether the tail carries obligations", rationale: "ADR-016: relevance is not pre-identifiable; a qualifying clause can sit anywhere in the document." },
        { action: "Re-capture in parts or raise STORAGE_MAX_CHARS for this source", rationale: "The ceiling is a pathological-page sanity bound, not an operating cap." },
      ],
      created_by: "capture-worker",
    })) as { error: { message: string } | null });
    if (fe) notes.push(`ceiling flag insert FAILED: ${fe}`);
  }
  if (c.itemIds.length) {
    const closed = msg((await db.from("integrity_flags").update({ status: "resolved", resolved_at: at, resolved_by: "capture-worker", resolution_note: `a fresh capture (${hash.slice(0, 12)}) of ${c.finalUrl} has a different body from the earlier one` }).eq("subject_type", "item").in("subject_ref", [...c.itemIds]).eq("created_by", STALE_FLAG_CREATOR).eq("status", "open")) as { error: { message: string } | null });
    if (closed) notes.push(`stale flag close FAILED: ${closed}`);
  }
  return { outcome: "captured", captureId: cap.id, runId: run.id, contentHash: hash, detail: notes.join("; "), retry: false };
}
