// The capture worker (ADR-016): INV-296 (the stored capture is the whole fetched document), INV-138 (the worker is service-role only), PROP-065/103 on the write path.
import assert from "node:assert/strict";
import { test } from "node:test";

import { drain, isServiceRoleRequest, processRow, type WorkerDeps } from "../../supabase/functions/capture-worker/process.ts";
import { memoryDb, type Failure } from "../_support/memory-db.ts";

const URL1 = "https://agency.gov/rule";
const prose = (n: number) => "The regulation requires operators to report greenhouse gas emissions under the scheme each year. ".repeat(n);
const page = (body: string) => `<html><head><title>The Rule</title></head><body><p>${body}</p></body></html>`;
const respond = (body: string, init: { status?: number; type?: string; url?: string } = {}) => new Response(body, { status: init.status ?? 200, headers: { "content-type": init.type ?? "text/html; charset=utf-8" } });

function world(opts: { items?: number; failures?: Failure[]; extra?: Record<string, Array<Record<string, unknown>>>; attempt?: number } = {}) {
  const items = Array.from({ length: opts.items ?? 1 }, (_, i) => ({ id: `item-${i}`, source_id: "src-1", is_archived: false }));
  return memoryDb(
    { sources: [{ id: "src-1", url: URL1, name: "Agency Rule" }], intelligence_items: items, pending_first_fetch: [{ id: "q-1", source_id: "src-1", status: "queued", attempt_count: opts.attempt ?? 0 }], ...(opts.extra ?? {}) },
    { ...(opts.failures ? { failures: opts.failures } : {}) },
  );
}
function deps(db: unknown, fetchImpl: typeof fetch, env: Record<string, string> = {}, extra: Partial<WorkerDeps> = {}): WorkerDeps & { calls: number } {
  const d = { db, env, now: () => Date.parse("2026-10-15T10:00:00Z"), calls: 0, ...extra } as WorkerDeps & { calls: number };
  d.fetchImpl = (async (...a: Parameters<typeof fetch>) => (d.calls++, fetchImpl(...a))) as typeof fetch;
  return d;
}
const row = (attempt_count = 0) => ({ id: "q-1", source_id: "src-1", status: "queued", attempt_count });

test("INV-296: the stored capture is the whole fetched document, item-linked when one live item exists", async () => {
  const w = world();
  const body = page(prose(80));
  const rep = await processRow(deps(w.db, (async () => respond(body)) as typeof fetch), row());
  assert.equal(rep.outcome, "captured");
  assert.equal(rep.intelligence_item_id, "item-0");
  const stored = w.tables.agent_run_searches?.[0];
  assert.ok(stored);
  const text = String(stored.result_content);
  assert.equal(text, body, "verbatim");
  assert.ok(Math.abs(text.length - (rep.chars ?? 0)) <= 50);
  assert.ok(text.length >= 0.98 * body.length);
  assert.equal(w.tables.pending_first_fetch?.[0]?.status, "done");
  assert.equal(w.tables.agent_runs?.[0]?.status, "success");
});
test("INV-296: two live items make the capture pool-scoped, never guessed", async () => {
  const w = world({ items: 2 });
  const rep = await processRow(deps(w.db, (async () => respond(page(prose(80)))) as typeof fetch), row());
  assert.equal(rep.outcome, "captured");
  assert.equal(rep.intelligence_item_id, null);
  assert.match(rep.detail ?? "", /pool-scoped/);
});
test("INV-296: a U+0000 removal is counted and declared on the run, not silent", async () => {
  const w = world();
  const body = page(prose(80) + "\u0000\u0000\u0000");
  const rep = await processRow(deps(w.db, (async () => respond(body)) as typeof fetch), row());
  assert.equal(rep.nulls_removed, 3);
  assert.equal(String(w.tables.agent_run_searches?.[0]?.result_content).includes("\u0000"), false);
  const errors = w.tables.agent_runs?.[0]?.errors as Array<{ declared_transform: string }>;
  assert.ok(errors.some((t) => t.declared_transform === "u0000-removal"));
});
test("PROP-103: binding the storage ceiling is loud: a declared transform, the report, and a coverage_gap flag", async () => {
  const w = world();
  const body = page(prose(200));
  const rep = await processRow(deps(w.db, (async () => respond(body)) as typeof fetch, { STORAGE_MAX_CHARS: "3000" }), row());
  assert.equal(rep.outcome, "captured");
  assert.equal(rep.storage_ceiling_bind?.collected, 3000);
  assert.ok((rep.storage_ceiling_bind?.fullLength ?? 0) > 3000);
  const flag = w.tables.integrity_flags?.[0];
  assert.equal(flag?.category, "coverage_gap");
  assert.equal(flag?.subject_ref, "item-0");
  const errors = w.tables.agent_runs?.[0]?.errors as Array<{ declared_transform: string }>;
  assert.ok(errors.some((t) => t.declared_transform === "storage-ceiling-bind"));
  assert.equal(w.tables.integrity_flags?.length, 1);
});
test("PROP-103: under the ceiling no flag is filed", async () => {
  const w = world();
  await processRow(deps(w.db, (async () => respond(page(prose(80)))) as typeof fetch), row());
  assert.equal(w.tables.integrity_flags, undefined);
});
test("a PDF is stored as its text layer with the extraction declared", async () => {
  const w = world();
  const text = prose(80);
  const rep = await processRow(deps(w.db, (async () => respond("%PDF-1.7 fake", { type: "application/pdf" })) as typeof fetch, {}, { extractPdf: async () => ({ text, pages: 12, title: "Rule" }) }), row());
  assert.equal(rep.outcome, "captured");
  assert.equal(rep.pdf_pages, 12);
  const errors = w.tables.agent_runs?.[0]?.errors as Array<{ declared_transform: string }>;
  assert.ok(errors.some((t) => t.declared_transform === "pdf-text-extraction"));
});
test("PROP-065: an error page is a recorded failure and nothing is stored", async () => {
  const w = world();
  const rep = await processRow(deps(w.db, (async () => respond(page(`Attention Required! | Cloudflare ${prose(40)}`))) as typeof fetch), row());
  assert.equal(rep.outcome, "failed");
  assert.equal(w.tables.agent_run_searches, undefined);
  assert.equal(w.tables.pending_first_fetch?.[0]?.status, "error");
  assert.equal(w.tables.agent_runs?.[0]?.status, "error");
});
test("a permanent non-200 fails at once; a transient 503 requeues", async () => {
  const gone = world();
  assert.equal((await processRow(deps(gone.db, (async () => respond("gone", { status: 404 })) as typeof fetch), row())).outcome, "failed");
  assert.equal(gone.tables.pending_first_fetch?.[0]?.status, "error");
  const busy = world();
  const rep = await processRow(deps(busy.db, (async () => respond("busy", { status: 503 })) as typeof fetch), row());
  assert.equal(rep.outcome, "requeued");
  assert.equal(busy.tables.pending_first_fetch?.[0]?.status, "queued");
  assert.equal(busy.tables.agent_runs, undefined, "a retry is not a capture outcome");
  assert.equal(busy.tables.pending_first_fetch?.[0]?.attempt_count, 1);
});
test("the fifth transient attempt terminalises instead of requeueing forever", async () => {
  const w = world({ attempt: 4 });
  const rep = await processRow(deps(w.db, (async () => respond("busy", { status: 503 })) as typeof fetch), row(4));
  assert.equal(rep.outcome, "failed");
  assert.equal(w.tables.pending_first_fetch?.[0]?.status, "error");
});
test("the claim is atomic: a row another run already holds is skipped and nothing is fetched", async () => {
  const w = world();
  w.tables.pending_first_fetch![0]!.status = "fetching";
  const d = deps(w.db, (async () => respond(page(prose(80)))) as typeof fetch);
  const rep = await processRow(d, row());
  assert.equal(rep.outcome, "skipped");
  assert.equal(d.calls, 0);
});
test("a failed claim write is reported as failed, never read as already claimed", async () => {
  const w = world({ failures: [{ table: "pending_first_fetch", op: "update", message: "locked", when: (c) => (c.payload as { status?: string }).status === "fetching" }] });
  const d = deps(w.db, (async () => respond(page(prose(80)))) as typeof fetch);
  const rep = await processRow(d, row());
  assert.equal(rep.outcome, "failed");
  assert.match(rep.detail ?? "", /claim write failed: locked/);
  assert.equal(d.calls, 0);
});
test("an idempotency read error requeues and never inserts", async () => {
  const w = world({ failures: [{ table: "agent_run_searches", op: "select", message: "timeout" }] });
  const rep = await processRow(deps(w.db, (async () => respond(page(prose(80)))) as typeof fetch), row());
  assert.equal(rep.outcome, "requeued");
  assert.match(rep.detail ?? "", /idempotency read failed/);
  assert.equal(w.wrote("agent_runs", "insert").length, 0);
  assert.equal(w.wrote("agent_run_searches", "insert").length, 0);
});
test("a second capture of the same final URL is skipped as a duplicate and the queue row closes", async () => {
  const w = world({ extra: { agent_run_searches: [{ id: "cap-0", result_url: URL1, search_query: "capture-worker:first-fetch" }] } });
  const rep = await processRow(deps(w.db, (async () => respond(page(prose(80)))) as typeof fetch), row());
  assert.equal(rep.outcome, "duplicate_skipped");
  assert.equal(rep.capture_id, "cap-0");
  assert.equal(w.wrote("agent_runs", "insert").length, 0);
  assert.equal(w.tables.pending_first_fetch?.[0]?.status, "done");
});
test("a failed capture insert marks the run errored and requeues, so a flag never points at a missing row", async () => {
  const w = world({ failures: [{ table: "agent_run_searches", op: "insert", message: "disk" }] });
  const rep = await processRow(deps(w.db, (async () => respond(page(prose(80)))) as typeof fetch, { STORAGE_MAX_CHARS: "3000" }), row());
  assert.equal(rep.outcome, "requeued");
  assert.equal(w.tables.agent_runs?.[0]?.status, "error");
  assert.equal(w.tables.integrity_flags, undefined);
});
test("a source read error is a recorded failure, not a crash", async () => {
  const w = world({ failures: [{ table: "sources", op: "select", message: "gone" }] });
  const rep = await processRow(deps(w.db, (async () => respond("x")) as typeof fetch), row());
  assert.equal(rep.outcome, "failed");
  assert.match(rep.detail ?? "", /source read failed/);
});

test("drain: a queue read failure is a 500, never an empty drain", async () => {
  const w = world({ failures: [{ table: "pending_first_fetch", op: "select", message: "down" }] });
  const out = await drain(deps(w.db, (async () => respond("x")) as typeof fetch), {});
  assert.equal(out.status, 500);
});
test("drain: the default takes queued rows only; an explicit replay may take a row at error", async () => {
  const w = world();
  w.tables.pending_first_fetch!.push({ id: "q-2", source_id: "src-1", status: "error", attempt_count: 1 });
  const d = deps(w.db, (async () => respond(page(prose(80)))) as typeof fetch);
  const plain = await drain(d, {});
  assert.equal(plain.body.processed, 1);
  const w2 = world();
  w2.tables.pending_first_fetch!.length = 0;
  w2.tables.pending_first_fetch!.push({ id: "q-2", source_id: "src-1", status: "error", attempt_count: 1 });
  const replay = await drain(deps(w2.db, (async () => respond(page(prose(80)))) as typeof fetch), { queue_ids: ["q-2"] });
  assert.equal((replay.body.results as Array<{ outcome: string }>)[0]?.outcome, "captured");
});

test("INV-138: only a service-role bearer reaches the worker", () => {
  assert.equal(isServiceRoleRequest("Bearer svc-key", "svc-key"), true);
  assert.equal(isServiceRoleRequest("Bearer svc-keY", "svc-key"), false);
  assert.equal(isServiceRoleRequest("Bearer svc-key-longer", "svc-key"), false);
  assert.equal(isServiceRoleRequest("svc-key", "svc-key"), false, "no bearer prefix");
  assert.equal(isServiceRoleRequest(null, "svc-key"), false);
  assert.equal(isServiceRoleRequest("Bearer ", ""), false, "an unset key admits no one");
  assert.equal(isServiceRoleRequest("Bearer anon-key", undefined), false);
});
