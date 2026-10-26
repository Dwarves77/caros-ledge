import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { correctionsFile } from "@/core/digest/corrections";
import { applyBatch } from "@/features/batches";
import { applyCommitted } from "@/features/batches/committed";

import { batchFile, batchWorld, goodBody, ITEM, recordEntry } from "../batches/world.ts";

type World = ReturnType<typeof batchWorld>;
const apply = (w: World, entries: unknown[], dry = false) => applyBatch("item-briefs", w.deps, { content: JSON.stringify(batchFile("item-briefs", entries)), dry, runId: "run-1" });
const item = (w: World) => w.db.rows("intelligence_items").find((r) => r.id === ITEM) as Record<string, unknown>;
const residue = (r: Awaited<ReturnType<typeof apply>>) => (r.data as { residue: { key: string; errors: string[] }[] }).residue;
const DASH = "—";

test("INV-VAL-2: a refuse violation blocks the apply, with the rule id named; the same text inside a guillemet run applies", async () => {
  const w = batchWorld();
  const refused = await apply(w, [recordEntry(w.db, { body: goodBody({ sec4: ` Late filings ${DASH} some of them ${DASH} cost more.` }) })]);
  assert.equal(refused.counts.applied, 0);
  assert.equal(refused.counts.refused, 1);
  assert.match(refused.notes.join("\n"), /dash-outside-verbatim: dash: "—"/);
  assert.equal(w.db.writes("intelligence_items").length, 0, "a refused entry wrote nothing");
  assert.equal(residue(refused)[0]?.errors.some((e) => e.includes("dash-outside-verbatim")), true, "the refusal is kept with its rule id");

  const quoted = await apply(w, [recordEntry(w.db, { body: goodBody({ sec4: ` «Late filings ${DASH} some of them ${DASH} cost more.»` }) })]);
  assert.equal(quoted.counts.applied, 1, quoted.notes.join("; "));
  assert.equal(item(w).item_grade, "brief");
  assert.match(String(item(w).full_brief), new RegExp(DASH));
});

test("INV-VAL-2: the other refuse rules block the apply too (a tier phrase, a schema name, a ledger key)", async () => {
  for (const [rule, text] of [["tier-phrase-exposure", " The source tier of this notice is high."], ["score-or-schema-token", " The intelligence_items row is updated."], ["no-claim-ledger-json", ' "claim_kind": "FACT", "source_span": "x"']] as const) {
    const w = batchWorld();
    const r = await apply(w, [recordEntry(w.db, { body: goodBody({ sec4: text }) })]);
    assert.equal(r.counts.applied, 0, rule);
    assert.equal(r.counts.refused, 1, rule);
    assert.match(r.notes.join("\n"), new RegExp(`${rule}:`), rule);
  }
});

test("INV-VAL-3: a residue violation lands in the residue row with its rule id; it is not applied, not refused, and does not hold the batch", async () => {
  const w = batchWorld();
  const bare = goodBody().replace("COST ALERT: ", "");
  const r = await apply(w, [recordEntry(w.db, { body: bare })]);
  assert.equal(r.counts.applied, 0);
  assert.equal(r.counts.residue, 1);
  assert.equal(r.counts.refused, 0, "a residue violation is not a refusal");
  assert.equal(w.db.writes("intelligence_items").length, 0, "a residue entry wrote nothing");
  assert.match(residue(r)[0]?.errors.join("\n") ?? "", /do-now-severity-label: do-now section 7 carries no severity label/);
  assert.match(r.notes.join("\n"), /do-now-severity-label/);

  // The ledger records the batch as applied (not held), with the residue row in its reasons: the item stays a record stub and is exported again.
  const root = mkdtempSync(join(tmpdir(), "caros-valid1-"));
  mkdirSync(join(root, "drain/batches/item-briefs"), { recursive: true });
  writeFileSync(join(root, "drain/batches/item-briefs/item-briefs-001.json"), JSON.stringify(batchFile("item-briefs", [recordEntry(w.db, { body: bare })])));
  const c = await applyCommitted(w.deps, { root, dry: false, runId: "run-2" });
  assert.deepEqual([c.data?.ids.held_batch_ids, c.data?.ids.applied_batch_ids], [[], ["item-briefs-001"]]);
  const ledger = w.db.rows("applied_batches").find((b) => b.batch_id === "item-briefs-001") as { status: string; reasons: { errors: string[] }[] };
  assert.equal(ledger.status, "applied");
  assert.match(JSON.stringify(ledger.reasons), /do-now-severity-label/);

  // The re-queue sees the rule ids: the corrections file DIGEST-1 PR B reads is written for a residue entry too, though the batch is not held; a clean batch writes none.
  const file = join(root, "drain/batches/item-briefs/item-briefs-001.corrections.json");
  const corrections = correctionsFile.parse(JSON.parse(readFileSync(file, "utf8")));
  assert.deepEqual(corrections.refused.map((x) => x.key), [ITEM]);
  assert.match(JSON.stringify(corrections.refused), /do-now-severity-label/);
  const clean = batchWorld();
  const root2 = mkdtempSync(join(tmpdir(), "caros-valid1-"));
  mkdirSync(join(root2, "drain/batches/item-briefs"), { recursive: true });
  writeFileSync(join(root2, "drain/batches/item-briefs/item-briefs-001.json"), JSON.stringify(batchFile("item-briefs", [recordEntry(clean.db)])));
  const ok = await applyCommitted(clean.deps, { root: root2, dry: false, runId: "run-3" });
  assert.deepEqual(ok.data?.ids.applied_batch_ids, ["item-briefs-001"]);
  assert.equal(existsSync(join(root2, "drain/batches/item-briefs/item-briefs-001.corrections.json")), false);
});

test("a refuse and a residue violation on the same entry: the entry is refused, and the refusal lists the residue reasons too so the author fixes both in one round", async () => {
  const w = batchWorld();
  const body = goodBody({ sec4: ` Late filings ${DASH} some of them ${DASH} cost more.` }).replace("COST ALERT: ", "");
  const r = await apply(w, [recordEntry(w.db, { body })]);
  assert.equal(r.counts.refused, 1);
  assert.equal(r.counts.residue, 0);
  const all = residue(r)[0]?.errors.join("\n") ?? "";
  assert.match(all, /dash-outside-verbatim/);
  assert.match(all, /do-now-severity-label/);
});

test("the stored dates of the item reach the stored-date-stated rule: a deadline the brief never writes routes the entry to residue", async () => {
  const w = batchWorld();
  Object.assign(item(w), { compliance_deadline: "2031-06-30" });
  const r = await apply(w, [recordEntry(w.db)]);
  assert.equal(r.counts.residue, 1);
  assert.match(residue(r)[0]?.errors.join("\n") ?? "", /stored-date-stated: compliance_deadline 2031-06-30 is never written/);
});
