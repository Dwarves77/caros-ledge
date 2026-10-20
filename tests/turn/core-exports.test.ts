// A test per export the core audit (C:119) found no test naming: the gate read's cousins, the streamed byte cap, the access-wall detector, the fetch outcome, the transport order, the held-pool read, the harness proofs and the small
// pure helpers beside them. Each states what the function promises and plants the input that breaks the promise. (revalidateItem, fetchDocumentApi and fetchHeadless are not tested here: the cache stand-in
// swallows revalidateTag and the other two need a live transport.)
import assert from "node:assert/strict";
import { test } from "node:test";

import { limitBytes } from "@/core/csv/stream";
import { exactCount, isMissingObject } from "@/core/db";
import { detectAccessWall } from "@/core/fetch/classify-body";
import { queryHeldPools } from "@/core/fetch/candidates";
import { nextScrapeDate } from "@/core/fetch/hold";
import { readBodyCapped } from "@/core/fetch/policy";
import { decideFetchOutcome } from "@/core/fetch/reachability";
import { extractCellarTitle } from "@/core/fetch/titles";
import { legacyLabelOfIso } from "@/core/jurisdictions/legacy";

import { changeProof, smokeProof } from "../_support/ledger-proofs.ts";
import { MemDb } from "../_support/memdb.ts";

test("isMissingObject: the four codes that say a pending migration's object is absent, and nothing else", () => {
  for (const code of ["42P01", "42883", "PGRST205", "PGRST202"]) assert.equal(isMissingObject({ code }), true, code);
  for (const code of ["42501", "23505", "PGRST116", ""]) assert.equal(isMissingObject({ code }), false, code);
  assert.equal(isMissingObject(null), false);
  assert.equal(isMissingObject(undefined), false);
  assert.equal(isMissingObject({}), false);
});

test("exactCount: the count the head query returned; an error or a missing count throws, never a length or a zero", async () => {
  assert.equal(await exactCount(Promise.resolve({ count: 0, error: null })), 0);
  assert.equal(await exactCount(Promise.resolve({ count: 1234, error: null })), 1234);
  await assert.rejects(exactCount(Promise.resolve({ count: null, error: null })), /no count returned/);
  await assert.rejects(exactCount(Promise.resolve({ count: 5, error: { message: "statement timeout" } as never })), /exact count failed: statement timeout/);
});

test("nextScrapeDate: null when off or unanchored; the anchor itself when it is ahead; weekly lands on the anchor's weekday; monthly clamps a short month", () => {
  const at = (ymd: string) => new Date(`${ymd}T10:30:00Z`);
  const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
  assert.equal(nextScrapeDate({ cadence: "off", startDate: "2026-11-02" }, at("2026-11-01")), null);
  assert.equal(nextScrapeDate({ cadence: "weekly", startDate: null }, at("2026-11-01")), null);
  assert.equal(nextScrapeDate({ cadence: "weekly", startDate: "not a date" }, at("2026-11-01")), null);
  assert.equal(day(nextScrapeDate({ cadence: "weekly", startDate: "2026-11-02" }, at("2026-10-01"))), "2026-11-02", "before the anchor: the anchor");
  assert.equal(day(nextScrapeDate({ cadence: "weekly", startDate: "2026-11-02" }, at("2026-11-02"))), "2026-11-02", "today counts");
  assert.equal(day(nextScrapeDate({ cadence: "weekly", startDate: "2026-11-02" }, at("2026-11-03"))), "2026-11-09");
  assert.equal(day(nextScrapeDate({ cadence: "monthly", startDate: "2026-01-31" }, at("2026-02-01"))), "2026-02-28", "the 31st clamps to the last day of February");
});

test("legacyLabelOfIso: a code's product label through its legacy slug; an unknown code is null, not a guess", () => {
  assert.equal(legacyLabelOfIso("GB"), "United Kingdom");
  assert.equal(legacyLabelOfIso("EU"), "EU");
  assert.equal(legacyLabelOfIso("ZZ"), null);
});

test("limitBytes: chunks pass until the limit, the chunk that crosses it is cut and the state says so; under the limit nothing is flagged", async () => {
  const collect = async (chunks: (string | Uint8Array)[], max: number) => {
    const state = { truncated: false };
    const out: Buffer[] = [];
    for await (const c of limitBytes(chunks, max, state)) out.push(Buffer.from(c));
    return { text: Buffer.concat(out).toString("utf8"), truncated: state.truncated };
  };
  assert.deepEqual(await collect(["abc", "def"], 10), { text: "abcdef", truncated: false });
  assert.deepEqual(await collect(["abc", "def", "ghi"], 5), { text: "abcde", truncated: true });
  assert.deepEqual(await collect(["abc", "def"], 6), { text: "abcdef", truncated: false }, "exactly the limit is not truncation");
  assert.deepEqual(await collect([new Uint8Array([1, 2, 3, 4])], 2).then((r) => ({ n: r.text.length, truncated: r.truncated })), { n: 2, truncated: true });
  assert.deepEqual(await collect(["abc"], 0), { text: "", truncated: true });
});

test("decideFetchOutcome: a body is ok; a 404 or 410 is dead (502); any other failure, a thrown error with no status and an error page served with 200 are inconclusive (503) and never evict", () => {
  assert.deepEqual(decideFetchOutcome({ content: "x".repeat(2000) }), { kind: "ok", httpStatus: 200 });
  assert.deepEqual(decideFetchOutcome({ error: { status: 404 } }), { kind: "dead", httpStatus: 502 });
  assert.deepEqual(decideFetchOutcome({ error: { message: "upstream said 410 gone" } }), { kind: "dead", httpStatus: 502 }, "a status inside a thrown message drives the verdict");
  assert.deepEqual(decideFetchOutcome({ error: { status: 503 } }), { kind: "inconclusive", httpStatus: 503 });
  assert.deepEqual(decideFetchOutcome({ error: { message: "socket hang up" } }), { kind: "inconclusive", httpStatus: 503 });
  assert.deepEqual(decideFetchOutcome({ content: "Access denied" }), { kind: "inconclusive", httpStatus: 503, reason: "error-body" });
});

test("extractCellarTitle: the oj-doc-ti lines joined; an act with none falls back to the body lead; empty is null", () => {
  const html = '<html><head><title>L_2023123EN.01000101.xml</title></head><body><p class="oj-doc-ti">COMMISSION REGULATION (EU) 2023/1234</p><p class="oj-doc-ti">of 5 May 2023</p><p>Body text.</p></body></html>';
  assert.deepEqual(extractCellarTitle(html), { title: "COMMISSION REGULATION (EU) 2023/1234 of 5 May 2023", origin: "cellar_doc_title" });
  const lead = extractCellarTitle("<html><body><p>Some regulation text without a title class that is long enough to lead.</p></body></html>");
  assert.equal(lead?.origin, "captured_body_lead");
  assert.equal(extractCellarTitle(""), null);
});

test("queryHeldPools: the item's own pool first, then connected items in the caller's order; an item with no usable capture is not a hit; no item id is no hits", async () => {
  const pools = new Map([
    ["a", [{ url: "https://x.example/a", text: "alpha text" }]],
    ["b", [{ url: "https://x.example/b", text: "   " }]],
    ["c", [{ url: "https://x.example/c", text: "gamma text" }]],
  ]);
  const deps = { readConnectedItemIds: () => ["b", "c", "a", ""], readPools: (ids: string[]) => new Map(ids.map((id) => [id, pools.get(id) ?? []])), hashSourcePool: (pool: { url: string }[]) => `h:${pool.length}` };
  const hits = await queryHeldPools({ itemId: "a" }, deps as never);
  assert.deepEqual(hits.map((h) => [h.item_id, h.relation, h.item_pool_hash]), [["a", "self", "h:1"], ["c", "connected", "h:1"]]);
  assert.deepEqual(await queryHeldPools({ itemId: "" }, deps as never), []);
});

test("the harness proofs read the one ledger: changeProof is an applied change-detection run that detected a change; smokeProof is the live-smoke row of the deployed sha and ok only if it succeeded", async () => {
  const row = (over: Record<string, unknown>) => ({ root_run_id: "r", upstream_run_id: null, started_at: "2026-10-19T10:00:00Z", code_sha: null, ...over });
  const db = new MemDb({ schema: null }, {
    harness_runs: [
      row({ id: "1", family: "change-detection", mode: "apply", outcome: "success", outputs: { counts: { changes_detected: 2 } } }),
      row({ id: "2", family: "change-detection", mode: "dry", outcome: "success", outputs: { counts: { changes_detected: 9 } } }),
      row({ id: "3", family: "change-detection", mode: "apply", outcome: "noop", outputs: { counts: { changes_detected: 0 } } }),
      row({ id: "4", family: "live-smoke", mode: "apply", outcome: "failed", code_sha: "abc", started_at: "2026-10-19T10:00:00Z", outputs: {} }),
      row({ id: "5", family: "live-smoke", mode: "apply", outcome: "success", code_sha: "abc", started_at: "2026-10-19T11:00:00Z", outputs: {} }),
      row({ id: "6", family: "live-smoke", mode: "apply", outcome: "failed", code_sha: "def", outputs: {} }),
    ],
  });
  assert.deepEqual((await changeProof(db.client)).map((r) => r.id), ["1"], "dry runs and runs that detected nothing are not the proof");
  const abc = await smokeProof(db.client, "abc");
  assert.deepEqual([abc.ok, abc.row?.id], [true, "5"], "the newest row of that sha decides");
  assert.deepEqual((await smokeProof(db.client, "def")).ok, false);
  assert.deepEqual(await smokeProof(db.client, "none"), { ok: false, row: null });
});

test("detectAccessWall: a challenge page is a wall, real content is not, an empty body is not", () => {
  assert.equal(detectAccessWall("Just a moment... Performing security verification")?.class, "bot_wall");
  assert.equal(detectAccessWall("The regulation applies to carriers from 1 January 2026. ".repeat(10)), null);
  assert.equal(detectAccessWall("   "), null, "an empty body is not a wall");
  assert.equal(detectAccessWall(null), null);
});
test("readBodyCapped: a declared length over the cap is refused before a byte is read; a stream is cancelled the instant it crosses the cap; a body inside the cap is returned whole", async () => {
  const text = (r: Uint8Array) => Buffer.from(r).toString("utf8");
  const tooLarge = (e: unknown) => (e as Error).name === "BodyTooLargeError";
  assert.equal(text(await readBodyCapped(new Response("hello world"), 100)), "hello world");
  await assert.rejects(readBodyCapped(new Response("x".repeat(50), { headers: { "content-length": "50" } }), 10), tooLarge);
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(10));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(readBodyCapped(new Response(stream), 25), tooLarge);
  assert.equal(cancelled, true, "the download was cancelled, not buffered to the end");
  assert.ok(pulled <= 5, `the reader stopped after ${pulled} chunks`);
});
