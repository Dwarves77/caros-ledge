// Host verdicts (IMP-054): a session-authored batch of {host, class, evidence, verdict_source, generated_at} lands in host_verdicts through the kit's one apply loop, is read back, and is read again by loadHostVerdicts into the
// map every rating takes. The class is the class table's (never a tier), an aggregator or hosting platform is never ruled, a re-apply writes nothing.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { isKnownHostClass, loadHostVerdicts, placeHostWithVerdicts } from "@/core/sources";
import { applyBatch, exportBatch } from "@/features/batches";

import { memoryDb } from "../_support/memory-db.ts";

const NOW = new Date("2026-10-17T12:00:00Z");
const entry = (over: Record<string, unknown> = {}) => ({ host: "unplaced.example", class: "association", evidence: "the maker's trade body", verdict_source: "session-lane", generated_at: NOW.toISOString(), ...over });
const file = (entries: unknown[], batch = "host-verdicts-001") => JSON.stringify({ batch, generated_at: NOW.toISOString(), authored_by: "session-lane", entries });
const world = (seed: Record<string, Record<string, unknown>[]> = {}) => {
  const db = memoryDb(seed);
  return { db, deps: { sb: db.db, now: () => NOW, intake: {} as never } };
};

test("a batch is validated whole, applied into host_verdicts with its batch and evidence, read back, and a re-apply writes nothing; a changed class is a new ruling", async () => {
  const w = world();
  const dry = await applyBatch("host-verdicts", w.deps, { content: file([entry()]), dry: true });
  assert.equal(w.db.wrote("host_verdicts").length, 0, "a dry apply writes nothing");
  assert.notEqual(dry.outcome, "failed");
  const run = await applyBatch("host-verdicts", w.deps, { content: file([entry(), entry({ host: "www.Second.Example", class: "gov" })]), dry: false });
  assert.deepEqual([run.outcome, run.counts.applied, run.counts.verdicts_written, run.counts.read_back_failures], ["ok", 2, 2, 0]);
  assert.deepEqual(w.db.tables.host_verdicts?.map((r) => [r.host, r.class, r.batch_id, r.ruled_by, r.reason]).sort(), [["second.example", "gov", "host-verdicts-001", "session-lane", "the maker's trade body"], ["unplaced.example", "association", "host-verdicts-001", "session-lane", "the maker's trade body"]]);
  const again = await applyBatch("host-verdicts", w.deps, { content: file([entry()]), dry: false });
  assert.equal(again.counts.applied ?? 0, 0, "already applied");
  assert.equal(w.db.wrote("host_verdicts").length, 2, "only the first apply wrote (one write per entry); the re-apply wrote none");
  const reruled = await applyBatch("host-verdicts", w.deps, { content: file([entry({ class: "news" })], "host-verdicts-002"), dry: false });
  assert.equal(reruled.counts.applied, 1);
  assert.deepEqual(w.db.tables.host_verdicts?.find((r) => r.host === "unplaced.example")?.batch_id, "host-verdicts-002", "the later ruling wins per host");
});

test("an entry that names a tier, an unknown class, a path as the host, another source, an aggregator or no evidence is refused alone with its reason; the good entry still lands", async () => {
  const w = world();
  const bad = [entry({ host: "a.example", tier: 1 }), entry({ host: "b.example", class: "tier-1" }), entry({ host: "https://c.example/x" }), entry({ host: "d.example", verdict_source: "someone" }), entry({ host: "law.justia.com", class: "legal" }), entry({ host: "e.example", evidence: " " })];
  const run = await applyBatch("host-verdicts", w.deps, { content: file([...bad, entry()]), dry: false });
  assert.deepEqual([run.outcome, run.counts.applied, run.counts.refused], ["partial", 1, 6]);
  assert.deepEqual(w.db.tables.host_verdicts?.map((r) => r.host), ["unplaced.example"]);
  const notes = run.notes.join("|");
  for (const re of [/names a class, never a tier/, /unknown class "tier-1"/, /bare hostname/, /verdict_source must be "session-lane"/, /aggregator or hosting platform is never registered/, /evidence is required/]) assert.match(notes, re);
  assert.equal((await applyBatch("host-verdicts", w.deps, { content: file([entry()], "wrong-name"), dry: false })).outcome, "failed", "a batch name outside the pattern refuses the whole file");
});

test("export (IMP-114): the queue is host_worklist, most-seen first, with the classes a verdict may name; an absent or unreadable table is a named failure, never an empty queue; a failed write is counted and reported, never a success", async () => {
  const w = world({ host_worklist: [{ host: "b.example", reason: "r", seen_count: 9, first_seen_at: "2026-10-01T00:00:00Z", last_seen_at: "2026-10-02T00:00:00Z", last_name: "B Org" }, { host: "a.example", reason: "r", seen_count: 2, first_seen_at: "2026-10-01T00:00:00Z", last_seen_at: "2026-10-03T00:00:00Z", last_name: null }, { host: "c.example", reason: "r", seen_count: 2, first_seen_at: "2026-10-01T00:00:00Z", last_seen_at: "2026-10-02T00:00:00Z", last_name: null }] });
  const dir = mkdtempSync(join(tmpdir(), "caros-hv-export-"));
  const ex = await exportBatch("host-verdicts", w.deps, { outDir: dir, runId: "hv" });
  assert.equal(ex.outcome, "ok");
  const part = JSON.parse(readFileSync((ex.data as { ids: { parts: string[] } }).ids.parts[0] as string, "utf8")) as { items: { host: string }[]; summary: { classes: string[] } };
  assert.deepEqual(part.items.map((i) => i.host), ["b.example", "a.example", "c.example"], "most seen first, ties by host");
  assert.ok(part.summary.classes.includes("association") && part.summary.classes.every((c) => isKnownHostClass(c)), "the classes are the class table's");
  const limited = await exportBatch("host-verdicts", w.deps, { outDir: dir, runId: "hv2", limit: 1 });
  assert.equal(limited.counts.exported, 1);
  const absent = world();
  absent.db.mem.fail("host_worklist", "select", "relation does not exist", { code: "PGRST205" });
  const none = await exportBatch("host-verdicts", absent.deps, { outDir: dir, runId: "hv3" });
  assert.deepEqual([none.outcome], ["failed"]);
  assert.match(none.notes.join("|"), /host_worklist is absent \(migration 0064/);
  const broken = world();
  broken.db.mem.fail("host_worklist", "select", "down");
  assert.match((await exportBatch("host-verdicts", broken.deps, { outDir: dir, runId: "hv4" })).notes.join("|"), /could not be read: down/);
  w.db.mem.fail("host_verdicts", "upsert", "write refused");
  const run = await applyBatch("host-verdicts", w.deps, { content: file([entry()]), dry: false });
  assert.deepEqual([run.counts.applied ?? 0, run.counts.write_failures], [0, 1]);
  assert.notEqual(run.outcome, "ok");
});

test("loadHostVerdicts returns the committed map the rating reads: a verdict places an unplaced host at its class's tier and a host the class table places is not overridden", async () => {
  const w = world();
  await applyBatch("host-verdicts", w.deps, { content: file([entry(), entry({ host: "eur-lex.europa.eu", class: "news" })]), dry: false });
  const notes: string[] = [];
  const verdicts = await loadHostVerdicts(w.db.db, notes);
  assert.deepEqual([...verdicts.keys()].sort(), ["eur-lex.europa.eu", "unplaced.example"]);
  assert.deepEqual(notes, []);
  const placed = placeHostWithVerdicts("unplaced.example", null, verdicts);
  assert.deepEqual([placed.tier, placed.via, placed.verdict?.batch], [4, "verdict", "host-verdicts-001"]);
  assert.equal(placeHostWithVerdicts("eur-lex.europa.eu", null, verdicts).via, "class", "the class table places a host before any verdict is read");
  assert.equal(placeHostWithVerdicts("nobody.example", null, verdicts).tier, null, "nothing is invented for a host with no verdict");
});

test("loadHostVerdicts pages through more than one page of verdicts and never passes a partial map off as the whole", async () => {
  const rows = Array.from({ length: 1005 }, (_, i) => ({ host: `h${String(i).padStart(4, "0")}.example`, class: "company", batch_id: "host-verdicts-001" }));
  assert.equal((await loadHostVerdicts(world({ host_verdicts: rows }).db.db)).size, 1005);
  const w = world({ host_verdicts: rows });
  let page = 0;
  w.db.mem.failWhen = (c) => (c.table === "host_verdicts" && (page += 1) === 2 ? "second page down" : null);
  const notes: string[] = [];
  assert.equal((await loadHostVerdicts(w.db.db, notes)).size, 0);
  assert.match(notes[0] ?? "", /could not be read.*second page down/);
});
