// R2b I5 (register D:10, 69, 114). INV-R2b-4: a hand-typed filing_grade_years entry fails the drift guard. A quote is accepted only against a STORED capture id that holds it, with a verified_at that parses; filing grade is
// derived from those checks; the producer citation and the statutory input use the one rule; a second instrument is a data row, not a code change.
import assert from "node:assert/strict";
import { test } from "node:test";

import { acceptQuote, acceptStoredQuote, parseVerifiedAt } from "@/core/producers/quote";
import { registerCitedSource, requireCitation } from "@/core/producers/rows-file";
import { deriveInstrument, filingInstruments, FUELEU_INSTRUMENT, type FilingInstrument } from "@/features/statutory";
import { statutoryRun } from "@/features/statutory/run";
import { validateRowsFile, verifyRowQuotes } from "@/features/statutory/rows";

import { installLedgerRpcs } from "../_support/ledger-rpcs.ts";
import { MemDb } from "../_support/memdb.ts";

import { committedFilingGrade, derivedFilingGrade, exportedCaptures, headerOf } from "./filing-grade-support.mjs";

const NOW = new Date("2026-10-20T00:00:00Z");
const TEXT = "Article 4(2). The limit referred to in paragraph 1 shall be calculated by reducing the reference value of 91,16 grams of CO2 equivalent per MJ by the following percentage: — 2 % from 1 January 2025; — 6 % from 1 January 2030;";
const REF = "The limit referred to in paragraph 1 shall be calculated by reducing the reference value of 91,16 grams of CO2 equivalent per MJ by the following percentage:";
const instrument = (over: Partial<FilingInstrument> = {}): FilingInstrument => ({ id: "fixture-instrument", captureId: "cap-1", verifiedAt: "2026-10-01", reuseTerms: "eu_reuse", yearQuotes: { "2025": [REF, "— 2 % from 1 January 2025;"], "2030": [REF, "— 6 % from 1 January 2030;"], "2035": [REF, "— 14,5 % from 1 January 2035;"] }, ...over });

test("acceptQuote: a quote stands only on a stored capture id whose text holds it verbatim, with a verified_at that parses; every refusal names its reason", () => {
  const base = { quote: REF, verifiedAt: "2026-10-01", captureId: "cap-1", captureText: TEXT, reuseTerms: "eu_reuse" as const, now: NOW };
  assert.deepEqual(acceptQuote(base), { ok: true, captureId: "cap-1", verifiedAt: "2026-10-01" });
  assert.equal(acceptQuote({ ...base, quote: REF.toUpperCase() }).ok, true, "criterion 3 is case-insensitive");
  const refusal = (over: Record<string, unknown>) => { const v = acceptQuote({ ...base, ...over } as never); return v.ok ? "accepted" : v.reason; };
  assert.equal(refusal({ captureId: null }), "no_capture_id", "a quote with no capture id is not accepted");
  assert.equal(refusal({ captureId: "" }), "no_capture_id");
  assert.equal(refusal({ captureText: null }), "capture_text_missing");
  assert.equal(refusal({ quote: "The limit is 99 grams per MJ." }), "quote_not_in_capture", "an unverifiable quote is refused");
  assert.equal(refusal({ quote: "  " }), "quote_blank");
  for (const bad of ["", "yesterday", "2026-02-30", "26-10-01", null, 20261001, "2999-01-01"]) assert.equal(refusal({ verifiedAt: bad }), "verified_at_unparseable", String(bad));
  assert.equal(parseVerifiedAt("2026-10-01T12:00:00Z", NOW), "2026-10-01");
});

test("filing grade is DERIVED: a year is filing grade only when every one of its quotes is accepted against the stored capture; a capture that lacks one quote, a missing capture and a bad date each leave the year out with the reason", () => {
  const ok = deriveInstrument(instrument(), TEXT, NOW);
  assert.deepEqual(ok.years, [2025, 2030]);
  assert.deepEqual(ok.refusals.map((r) => [r.year, r.reason]), [[2035, "quote_not_in_capture"]], "2035's quote is not in the capture");
  assert.deepEqual(deriveInstrument(instrument({ captureId: null }), TEXT, NOW).years, []);
  assert.deepEqual(deriveInstrument(instrument(), null, NOW).years, []);
  assert.deepEqual(deriveInstrument(instrument({ verifiedAt: "soon" }), TEXT, NOW).years, []);
  const second = instrument({ id: "second-instrument", captureId: "cap-2", yearQuotes: { "2031": ["Article 9. The cap is 12 percent."] } });
  const captures = new Map([["cap-1", TEXT], ["cap-2", "Article 9. The cap is 12 percent. More text."]]);
  const doc = { instruments: Object.fromEntries([instrument(), second].map((i) => [i.id, deriveInstrument(i, i.captureId ? captures.get(i.captureId) : null, NOW)])) };
  assert.deepEqual(doc.instruments["fixture-instrument"]?.years, [2025, 2030]);
  assert.deepEqual(doc.instruments["second-instrument"]?.years, [2031], "a second instrument is a data row with its quotes and its own stored capture; no code changes");
});

test("INV-R2b-4 (drift guard): data/filing-grade.json equals the derivation from its evidence and the exported captures; a hand-typed year, an edited refusal or a removed header fails", () => {
  const committed = committedFilingGrade();
  assert.equal(committed._generated, headerOf());
  const derived = derivedFilingGrade(new Date());
  assert.deepEqual(committed.instruments, derived.instruments, "run `node --import ./tests/_support/register.mjs tests/statutory/regenerate.mjs`; never edit the file");
  // the attack: a person adds 2025 to the committed file by hand
  const handTyped = structuredClone(committed);
  (handTyped.instruments[FUELEU_INSTRUMENT] as { years: number[] }).years = [2025];
  assert.notDeepEqual(handTyped.instruments, derived.instruments, "a hand-typed filing-grade year is not what the derivation yields");
  // every instrument the file lists is derived from an evidence row, and no capture file is orphaned
  assert.deepEqual(Object.keys(committed.instruments).sort(), filingInstruments().map((i) => i.id).sort());
  const known = new Set(filingInstruments().map((i) => i.captureId));
  for (const id of exportedCaptures().keys()) assert.ok(known.has(id), `data/captures/${id}.txt is exported but no evidence row names it`);
});

test("the statutory row's source block: verified_at must be a date; and each input's quote must stand on a stored capture that holds it, else the row is refused (dry or not); the capture id is recorded on the computation", async () => {
  const block = (over: Record<string, unknown> = {}) => ({ url: "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32023R1805", article: "Article 4(2)", quote: REF, verified_at: "2026-10-01", ...over });
  const input = (value: number, unit: string) => ({ value, unit, citation: "Annex", asOf: { eventDate: "2026-06-01" }, derivation: "observed", originClass: "official", lifecycle: "verified", admissibility: "filing_ok", baseConfidence: 1, source: block() });
  const row = { shipKey: "IMO-1", targetYear: 2025, ghgIntensityActual: input(90, "gCO2eq/MJ"), energyUsedMJ: input(1000, "MJ"), consecutiveDeficitYears: input(1, "years") };
  assert.deepEqual(validateRowsFile({ rows: [row] }), []);
  assert.match(validateRowsFile({ rows: [{ ...row, ghgIntensityActual: { ...row.ghgIntensityActual, source: block({ verified_at: "last week" }) } }] }).join(), /verified_at "last week" is not a date/);
  const db = new MemDb();
  installLedgerRpcs(db);
  db.seed("intelligence_items", [{ id: "i1" }]);
  db.seed("agent_run_searches", [{ id: "cap-9", intelligence_item_id: "i1", result_url: block().url, result_content: TEXT, result_index: 0, searched_at: "2026-10-01T00:00:00Z" }]);
  const deps = (sb: unknown) => ({ sb: sb as never, now: () => NOW, statutory: { computeStatutory: () => ({ result: 10, resultUnit: "EUR" }), formulaVersion: "v1", statuteCitation: "c", unitPriceEurPerTVlsfoe: 1 } as never });
  const refused = await statutoryRun(deps(db), { dry: true, file: { rows: [{ ...row, ghgIntensityActual: { ...row.ghgIntensityActual, source: block({ quote: "The limit is 99 grams per MJ." }) } }] } });
  assert.equal(refused.counts.refused, 1);
  assert.equal(refused.data?.perItem[0]?.outcome, "refused-quote");
  assert.match(refused.data?.perItem[0]?.detail ?? "", /ghgIntensityActual: quote_not_in_capture/);
  const accepted = await statutoryRun(deps(db), { dry: true, file: { rows: [row] } });
  assert.equal(accepted.counts.refused ?? 0, 0, accepted.data?.perItem[0]?.detail ?? "");
  const proof = await verifyRowQuotes(db.client, row, NOW);
  assert.deepEqual(proof, { ok: true, captureIds: { ghgIntensityActual: "cap-9", energyUsedMJ: "cap-9", consecutiveDeficitYears: "cap-9" } });
  const verdict = await acceptStoredQuote(db.client, { url: block().url, quote: REF, verifiedAt: "2026-10-01", now: NOW });
  assert.deepEqual(verdict, { ok: true, captureId: "cap-9", verifiedAt: "2026-10-01" });
});

test("the producer citation path uses the same rule: retrieved_at must parse, and registerCitedSource refuses a quote no stored capture of the URL holds before it rates the host", async () => {
  const citation = { url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1805", title: "Reg", retrieved_at: "2026-10-01", quote: REF };
  assert.equal(requireCitation({ citation }, 0, "w").quote, REF);
  assert.throws(() => requireCitation({ citation: { ...citation, retrieved_at: "not a date" } }, 0, "w"), /retrieved_at "not a date" is not a date/);
  const db = new MemDb();
  installLedgerRpcs(db);
  db.seed("intelligence_items", [{ id: "i1" }]);
  db.seed("agent_run_searches", [{ id: "cap-p", intelligence_item_id: "i1", result_url: citation.url, result_content: TEXT, result_index: 0 }]);
  const unverified = await registerCitedSource({ ...citation, quote: "An invented sentence the page never held." }, { sb: db.client });
  assert.equal(unverified.refused, true);
  assert.match(unverified.refused ? unverified.reason : "", /quote_not_in_capture/);
  assert.equal(db.writes("sources").length, 0, "nothing was registered for an unverified quote");
  const verified = await registerCitedSource(citation, { sb: db.client });
  assert.ok(!verified.refused || !/quote_not_in_capture/.test(verified.reason), "a held quote passes the quote check");
});
