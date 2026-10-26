// A fixture run of every kind, end to end: export to a scratch directory, a session authors the batch FROM THE EXPORTED FILE, a dry apply writes nothing, the apply writes, and a re-apply writes nothing new. The
// zero-model guard wraps the whole run: any network call throws. Each case is the kit's front door (exportBatch, applyBatch), the same two functions the briefs stage calls.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyBatch, exportBatch } from "@/features/batches";

import { adminEntry, adminWorld } from "../digest/admin-world.ts";

import { batchFile, goodBody, claims, ITEM, metadata, NOW, SPAN_FORCE, SPAN_REPORT, withReview } from "./world.ts";
import { CLAIM, feWorld, hostWorld, ledgerFile, ledgerWorld, needsWorld, qaWorld, recordWorld, REF, screenWorld, themeWorld, THEME, verdict, T_FLAG, type World } from "./worlds.ts";

type Item = Record<string, unknown>;
interface Case { kind: string; world(): World; author(items: Item[], w: World): unknown; applied(w: World): number }

const mutations = (w: World) => w.db.writes().length;
const CASES: Case[] = [
  { kind: "item-briefs", world: recordWorld, author: (items) => batchFile("item-briefs", [withReview({ item_id: items[0]?.id, source_pool_hash: items[0]?.source_pool_hash, body: goodBody(), metadata: metadata(), claims: claims() })]), applied: (w) => w.db.rows("intelligence_items").filter((r) => r.item_grade === "brief").length },
  { kind: "admin-opportunity-findings", world: adminWorld as never, author: () => batchFile("admin-opportunity-findings", [adminEntry()]), applied: (w) => w.db.rows("admin_opportunity_findings").length },
  { kind: "question-answers", world: qaWorld, author: (items) => batchFile("question-answers", [{ subject_ref: REF, outcome: "answered", pool_hash: items[0]?.pool_hash, status_token: "CONFIRMED", confidence: 0.9, answer: SPAN_REPORT, cited_item_ids: [ITEM], evidence: [{ item_id: ITEM, claim_ids: [], source_span: SPAN_REPORT }] }]), applied: (w) => w.db.rows("inference_records").length },
  { kind: "needs-search", world: needsWorld, author: (items) => batchFile("needs-search", [{ need_id: items.find((i) => i.need_id === T_FLAG)?.need_id, url: "https://www.imo.org/en/OurWork/Environment/EEXI.aspx", institution: "International Maritime Organization", why_authoritative: "The IMO publishes the guidelines", confidence: 0.9 }]), applied: (w) => w.db.rows("census_worklist").length },
  { kind: "forward-events", world: feWorld, author: (items) => batchFile("forward-events", [{ item_id: items[0]?.id, ticket_ids: items[0]?.ticket_ids, events: [{ event_date: "2027-01-01", date_precision: "day", event_kind: "entry_into_force", obligation_text: "The Regulation enters into force on 1 January 2027.", source_kind: "claim", source_claim_id: ((items[0]?.claims as Item[])[0] as Item).claim_id ?? CLAIM, source_section_id: null, source_span: SPAN_FORCE, confidence: "high", extractor_version: "e2e" }] }]), applied: (w) => w.db.rows("item_forward_events").length },
  { kind: "theme-briefs", world: themeWorld, author: (items) => batchFile("theme-briefs", [withReview({ theme_id: THEME, member_hash: items[0]?.member_hash, title: "The reporting duty and the surcharge it triggers", sections: { connection: "Both items concern the annual reporting duty.", meaning: "A forwarder should expect the duty to reach the rate card.", ramifications: "### Regulations\nThe duty needs an owner in each operating unit.", watch: "Watch the next dated step.", gaps: "No operations item yet." }, claims: [{ section: "connection", text: "annual reporting duty", member_id: ITEM, claim_ids: [((items[0]?.members as Item[]).find((m) => m.id === ITEM)?.claims as Item[])[0]?.claim_id] }, { section: "watch", text: "Watch the next dated step.", member_id: "a0000000-0000-4000-8000-000000000002", claim_ids: [(((items[0]?.members as Item[]).find((m) => m.id !== ITEM)?.forward_events) as Item[])[0]?.event_id] }] }, "theme-briefs")]), applied: (w) => w.db.rows("theme_briefs").length },
  { kind: "screen-verdicts", world: screenWorld, author: (items) => ({ verdicts: items.map((i) => ({ census_id: i.census_id, verdict: "on_vertical", basis: "EU emissions regulation: core sustainability scope", reviewer: "e2e" })) }), applied: (w) => w.db.rows("screen_verdicts").length },
  { kind: "host-verdicts", world: hostWorld, author: (items) => ({ batch: "host-verdicts-001", generated_at: NOW.toISOString(), authored_by: "session-lane", entries: items.slice(0, 1).map((i) => ({ host: i.host, class: "association", evidence: "the maker's trade body", verdict_source: "session-lane", generated_at: NOW.toISOString() })) }), applied: (w) => w.db.rows("host_verdicts").length },
  { kind: "ledger-verdicts", world: ledgerWorld, author: (items) => ledgerFile(items.slice(0, 1).map((i) => verdict(String(i.url), { candidate_id: i.candidate_id }))), applied: (w) => w.db.rows("portal_link_candidates").filter((r) => r.status === "promoted").length },
];

for (const c of CASES) {
  test(`${c.kind}: export, author from the exported file, dry apply, apply, re-apply; no network call is made`, async () => {
    const w = c.world();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("a network call was attempted");
    }) as never;
    try {
      const dir = mkdtempSync(join(tmpdir(), `caros-e2e-${c.kind}-`));
      const ex = await exportBatch(c.kind, w.deps, { outDir: dir, runId: "e2e" });
      assert.ok((ex.counts.exported ?? 0) >= 1, `${c.kind}: ${ex.notes.join("; ")}`);
      const ids = (ex.data as { ids: { exported_ids: string[]; parts: string[] } }).ids;
      const part = JSON.parse(readFileSync(ids.parts[0] as string, "utf8")) as { kind: string; items: Item[] };
      assert.equal(part.kind, c.kind);
      assert.equal(ids.exported_ids.length, part.items.length);
      const file = JSON.stringify(c.author(part.items, w));

      const before = mutations(w);
      const dry = await applyBatch(c.kind, w.deps, { content: file, dry: true, runId: "e2e-dry" });
      assert.notEqual(dry.outcome, "failed", `${c.kind} dry: ${dry.notes.join("; ")}`);
      assert.equal(mutations(w), before, `${c.kind}: a dry apply writes nothing`);
      assert.equal(c.applied(w), 0);

      const run = await applyBatch(c.kind, w.deps, { content: file, dry: false, runId: "e2e-apply" });
      assert.ok((run.counts.applied ?? 0) >= 1 && run.outcome !== "failed", `${c.kind} apply: ${JSON.stringify(run.counts)} ${run.notes.join("; ")}`);
      assert.ok(c.applied(w) >= 1, `${c.kind}: the rows are there`);

      const after = mutations(w);
      const again = await applyBatch(c.kind, w.deps, { content: file, dry: false, runId: "e2e-again" });
      assert.equal(again.counts.applied ?? 0, 0, `${c.kind}: a re-apply applies nothing (${again.notes.join("; ")})`);
      assert.equal(mutations(w), after, `${c.kind}: a re-apply writes nothing new`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

test("every kind in the kit has a case here", async () => {
  const note = (await exportBatch("mystery", recordWorld().deps)).notes[0] ?? "";
  const kinds = /\(kinds: ([^)]*)\)/.exec(note)?.[1]?.split(", ") ?? [];
  assert.equal(kinds.length, 9, note);
  assert.deepEqual(CASES.map((c) => c.kind).sort(), [...kinds].sort());
});
