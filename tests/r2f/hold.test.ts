// R2f F3 and F4: the S-NUMERIC hold is written, the capture's number locale reaches Gate A, orphans are stored typed, and the healer reads numbers through the parser.
// INV-R2f-3: a mint whose brief figure differs from its FACT by scale ("EUR 15 million" against "EUR 150 million") is HELD with reason S-NUMERIC in the database, not soft-flagged.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildGateARow, groundBrief } from "@/core/grounding";
import { locateSpan } from "@/features/mint/heal/ground";

import { factClaim, ITEM, makeWorld, OFFICIAL_TEXT, OFFICIAL_URL, OTHER_URL, OTHER_TEXT } from "../intake/fixtures.ts";

const GRANT = "A grant of EUR 150 million is available to operators that register before 1 July 2027.";
const NOW = () => new Date("2026-10-15T00:00:00Z");

async function ground(claimText: string, over: { numberLocale?: string; pool?: string } = {}) {
  const text = `${OFFICIAL_TEXT}\nArticle 8. ${over.pool ?? GRANT}`;
  const w = makeWorld({ pool: [{ url: OFFICIAL_URL, text }, { url: OTHER_URL, text: OTHER_TEXT }] });
  if (over.numberLocale) for (const r of w.db.rows("agent_run_searches")) if (r.result_url === OFFICIAL_URL) r.number_locale = over.numberLocale;
  w.db.seed("intelligence_item_sections", [{ item_id: ITEM, section_key: "1", section_order: 1, content_md: claimText }]);
  const res = await groundBrief({ sb: w.deps.sb, sources: w.deps.sources, now: NOW }, { itemId: ITEM, ledger: [{ ...factClaim(over.pool ?? GRANT, { claim_text: claimText }), search_result_id: null }] as never });
  return { w, res };
}

test("INV-R2f-3: a claim that states EUR 15 million over a span that states EUR 150 million is HELD with S-NUMERIC in the database; a claim that respells the span's figure is not", async () => {
  const wrong = await ground("A grant of EUR 15 million is available to operators that register before 1 July 2027.");
  const held = wrong.w.db.rows("section_claim_provenance").filter((c) => c.claim_kind === "FACT");
  assert.ok(held.length === 1 && held[0]?.mint_hold_reason === "S-NUMERIC", JSON.stringify(held.map((c) => c.mint_hold_reason)));
  assert.equal(wrong.res.counts.mint_hold_numeric, 1);
  assert.equal(wrong.w.db.rows("integrity_flags").some((f) => f.created_by === "mint_gate_s_numeric"), false, "the hold is the record: no soft flag stands in for it");
  const right = await ground("A grant of €150 million is available to operators that register before 1 July 2027.");
  assert.equal(right.w.db.rows("section_claim_provenance").filter((c) => c.claim_kind === "FACT")[0]?.mint_hold_reason ?? null, null, "EUR 150 million and €150 million are one figure");
});

test("F3: Gate A reads each FACT under the number locale its capture declares: 1.200 is one thousand two hundred in a German capture and 1.2 in an undeclared one", () => {
  const brief = "Die Gesamtmenge beträgt 1.234,5 t. Der Preis liegt bei EUR 1.200 je Tonne.";
  const facts = [{ claim_text: "Der Preis", source_span: "Der Preis liegt bei EUR 1.200 je Tonne." }, { claim_text: "Menge", source_span: "Die Gesamtmenge beträgt 1.234,5 t." }];
  const undeclared = buildGateARow({ itemId: ITEM, fullBrief: brief, factClaims: facts, nowIso: "2026-10-15T00:00:00Z" });
  const declared = buildGateARow({ itemId: ITEM, fullBrief: brief, factClaims: facts.map((f) => ({ ...f, locale: "de-AT" })), nowIso: "2026-10-15T00:00:00Z" });
  assert.ok(undeclared.orphan_count > 0, "read as English, EUR 1.200 is 1.2 and the brief's 1200 is not backed");
  assert.equal(declared.orphan_count, 0, JSON.stringify(declared.orphans));
});

test("F3 end to end: ground passes the capture's number_locale into Gate A, so the stored state has no orphan for a German-format figure", async () => {
  const span = "Der Preis liegt bei EUR 1.200 je Tonne und die Menge bei 1.234,5 t.";
  const { w } = await ground(span, { numberLocale: "de", pool: span });
  const state = w.db.rows("item_gate_a_state")[0];
  assert.ok(state, "the Gate A state was written");
  assert.deepEqual(state.orphans, [], JSON.stringify(state.orphans));
});

test("F3: orphans are stored as typed rows: a figure carries its exact value, unit and kind, a refused figure its reason, a deadline its token", () => {
  const row = buildGateARow({ itemId: ITEM, fullBrief: "The fee is EUR 2 400 per tonne. It starts on 1 January 2027.", factClaims: [], nowIso: "2026-10-15T00:00:00Z" });
  const fee = (row.orphans as { token: string; class: string; value?: string; unit?: string; kind?: string }[]).find((o) => o.class === "figure");
  assert.deepEqual([fee?.token, fee?.value, fee?.unit, fee?.kind], ["EUR 2 400", "2400", "eur", "money_eur"]);
  assert.ok((row.orphans as { class: string; token: string }[]).some((o) => o.class === "deadline" && /2027/.test(o.token)));
  const mixed = buildGateARow({ itemId: ITEM, fullBrief: "Totals of 1.200,5 t and 1,200.5 t and 1,200 t.", factClaims: [], nowIso: "2026-10-15T00:00:00Z" });
  assert.ok((mixed.orphans as { reason?: string }[]).some((o) => typeof o.reason === "string" && o.reason.length > 0), "a figure the parser refuses is kept with its reason");
});

// ---- F4: the healer reads numbers through the parser --------------------------------------------------------------------------------------------------
const cap = (text: string, number_locale?: string) => ({ id: "c", result_url: null, result_content: text, ...(number_locale ? { number_locale } : {}) });

test("F4: a number is located by its value under the capture's own locale; a number the parser refuses is not located", () => {
  const german = cap("Die Strafe beträgt bis zu 1.200 Euro je Fall.", "de");
  assert.equal(locateSpan("1,200", german)?.span, "1.200", "English 1,200 and German 1.200 are one value");
  assert.equal(locateSpan("1,2", german), null, "1,2 is 1.2: not the capture's 1200");
  assert.equal(locateSpan("1.200", german)?.method, "exact");
  assert.equal(locateSpan("1 200", cap("A fine of up to 1,200 applies per case.", "en"))?.span, "1,200", "a group space and a group comma are one value in English");
  assert.equal(locateSpan("see 1.200,5", cap("Totals: 1.200,5 and 1,200.5 appear in this table.")), null, "a capture that mixes conventions has no locale: nothing is located by value");
  assert.equal(locateSpan("12,5", cap("The ratio is 12.5 percent of the fleet."))?.span, "12.5", "a bare number is found inside a figure printed with its unit");
  assert.equal(locateSpan("EUR 15 million", cap("a grant of EUR 150 million"))?.span ?? null, null, "a different scale is a different figure");
});
