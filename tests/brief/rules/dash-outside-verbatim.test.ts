import assert from "node:assert/strict";
import { test } from "node:test";

import { fixtureRow, run, ruleTests } from "../_cases.ts";

ruleTests("dash-outside-verbatim");

// INV-VAL-4: the exemption of a source's own punctuation is tested both ways, so the rule cannot be loosened to ignore dashes or tightened to refuse quotations.
const DASH = "—";
const inside = (id: string) => run("dash-outside-verbatim", fixtureRow(id).brief, fixtureRow(id).item);

test("INV-VAL-4: a dash inside a guillemet run passes, and the same dash outside it fails", () => {
  const quoted = fixtureRow("exempt-dash-guillemets");
  assert.ok(quoted.brief.body.includes(DASH), "the exempt twin carries a dash");
  assert.equal(inside("exempt-dash-guillemets"), null);
  const bare = { ...quoted.brief, body: quoted.brief.body.replace(/[«»]/g, "") };
  assert.equal(run("dash-outside-verbatim", bare, quoted.item)?.rule, "dash-outside-verbatim");
});

test("INV-VAL-4: a dash inside a FACT claim's span passes, and with the claim gone it fails", () => {
  const row = fixtureRow("exempt-dash-fact-span");
  assert.ok(row.brief.body.includes(DASH));
  assert.equal(inside("exempt-dash-fact-span"), null);
  assert.equal(run("dash-outside-verbatim", { ...row.brief, claims: [] }, row.item)?.rule, "dash-outside-verbatim");
});

test("INV-VAL-4: the exemption is the source_span only: a banned dash in a FACT claim's text outside its span is refused", () => {
  const row = fixtureRow("dash-in-claim-text-outside-span");
  assert.ok(row.brief.body.includes(DASH));
  assert.equal(row.brief.claims[0]?.kind, "FACT");
  assert.ok(row.brief.claims[0]?.text.includes(DASH), "the dash is in the claim's text");
  assert.equal(run("dash-outside-verbatim", row.brief, row.item)?.rule, "dash-outside-verbatim");
  // The same dash inside the span is exempt (the span-case twin above), so the span, not the claim, is what is source wording.
  const inSpan = { ...row.brief, claims: [{ ...row.brief.claims[0] as NonNullable<(typeof row.brief.claims)[0]>, span: row.brief.claims[0]?.text ?? null }] };
  assert.equal(run("dash-outside-verbatim", inSpan, row.item), null);
});

test("an en dash is a dash too, and an adapter's exempt run (an old-tree quotation) is verbatim text", () => {
  const clean = fixtureRow("clean-market");
  const en = { ...clean.brief, body: `${clean.brief.body}\n\nQuotes run 2026–2027.` };
  assert.equal(run("dash-outside-verbatim", en, clean.item)?.rule, "dash-outside-verbatim");
  assert.equal(run("dash-outside-verbatim", { ...en, exempt: ["Quotes run 2026–2027."] }, clean.item), null);
});
