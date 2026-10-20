import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { locateCalendarDate, tryParseDateAt, tryParseDateOrBareYearAt } from "@/features/obligations/extract/date-grammar";
import { dedupeEvents } from "@/features/obligations/extract/dedupe";
import { EXTRACTOR_VERSION, extractForwardEvents } from "@/features/obligations/extract/extract-forward-events";
import { RULES } from "@/features/obligations/extract/rules";
import { needsDueDateContext, scanText } from "@/features/obligations/extract/scan";
import { assertVerbatim } from "@/core/contracts/verbatim";
import { clauseAround, normalizeObligationText } from "@/features/obligations/extract/window";
import type { ClaimIn } from "@/features/obligations/extract/scan";

const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const input = read("forward-events-input.json") as { referenceDates: string[]; claims: ClaimIn[]; sections: { section_id: string; key: string; md: string }[] };
const golden = read("forward-events-golden.json") as { claims: { claim_id: string; out: unknown }[]; noContext: { claim_id: string; out: unknown }[]; sections: { section_id: string; out: unknown }[] };

test("the port reproduces the old extractor exactly over the frozen live fixture (124 slot claims, with and without capture context)", () => {
  assert.equal(input.claims.length, 124);
  input.claims.forEach((c, i) => {
    assert.deepEqual(extractForwardEvents({ claims: [c], sections: [], referenceDates: input.referenceDates }), (golden.claims[i] as { out: unknown }).out, `claim ${c.claim_id} with context`);
    const bare: Record<string, unknown> = { ...c };
    delete bare.context;
    assert.deepEqual(extractForwardEvents({ claims: [bare as unknown as typeof c], sections: [], referenceDates: input.referenceDates }), (golden.noContext[i] as { out: unknown }).out, `claim ${c.claim_id} without context`);
  });
});

test("the port reproduces the old extractor over the synthetic record-facts sections", () => {
  input.sections.forEach((s, i) => assert.deepEqual(extractForwardEvents({ claims: [], sections: [s], referenceDates: input.referenceDates }), (golden.sections[i] as { out: unknown }).out, s.section_id));
});

const ev = (text: string, opts: { referenceDates?: string[] } = {}) => scanText(text, opts);

test("one case per trigger rule (INV-217/218): the rule fires, with its kind and a verbatim date span", () => {
  const cases: [string, string, string, string][] = [
    ["entered-into-force-on", "The Regulation entered into force on 12 September 2023.", "2023-09-12", "entry_into_force"],
    ["enters-into-force-on", "The Directive enters into force on 1 January 2027.", "2027-01-01", "entry_into_force"],
    ["shall-enter-into-force-on", "This Regulation shall enter into force on 15 March 2028.", "2028-03-15", "entry_into_force"],
    ["applicable-since", "The standard is applicable since 2 February 2025.", "2025-02-02", "entry_into_force"],
    ["shall-apply-from", "It shall apply from 1 July 2029.", "2029-07-01", "entry_into_force"],
    ["review-shall-be-completed-by", "The review shall be completed by 30 June 2031.", "2031-06-30", "review_or_report"],
    ["by-report-clause", "By 31 December 2032, the Commission shall report on the review.", "2032-12-31", "review_or_report"],
    ["no-later-than", "Operators must submit the report no later than 31 March 2030.", "2030-03-31", "compliance_deadline"],
    ["by-comma-deadline", "By 1 May 2029, operators shall register.", "2029-05-01", "compliance_deadline"],
    ["deadline-is", "The deadline for filing is 15 June 2030.", "2030-06-15", "compliance_deadline"],
    ["the-deadline-is", "The new deadline for reporting is 1 September 2030.", "2030-09-01", "compliance_deadline"],
    ["with-effect-from-shall", "With effect from 1 January 2031 operators shall hold allowances.", "2031-01-01", "compliance_deadline"],
    ["consultation-ending-on", "The public consultation, ending on 10 November 2026, invites comments.", "2026-11-10", "consultation_close"],
    ["consultation-closes", "The consultation closes on 20 December 2026.", "2026-12-20", "consultation_close"],
    ["comments-due-by", "Comments are due by 5 January 2027.", "2027-01-05", "consultation_close"],
    ["repealed-with-effect-from", "The Order is repealed with effect from 1 April 2028.", "2028-04-01", "other"],
    ["a-partir-de", "O regime aplica-se a partir de 1 de janeiro de 2028.", "2028-01-01", "phase_step"],
    ["ate-date", "O prazo termina até 15 de março de 2029.", "2029-03-15", "phase_step"],
    ["by-year-target", "Operators shall reduce emissions by 2030.", "2030-01-01", "compliance_deadline"],
    ["from-year", "The scheme, which operators must follow, runs from 2028.", "2028-01-01", "compliance_deadline"],
  ];
  assert.equal(RULES.length, 20);
  for (const [name, text, iso, kind] of cases) {
    const { hits } = ev(text);
    const hit = hits.find((h) => h.iso === iso);
    assert.ok(hit, `${name}: no hit for ${iso} in ${JSON.stringify(text)} (hits ${JSON.stringify(hits.map((h) => [h.ruleName, h.iso]))})`);
    assert.equal(hit.kind, kind, `${name}: kind`);
    assert.ok(text.includes(hit.dateSpan), `${name}: the span is verbatim`);
  }
});

test("a weekday prefix is skipped, a citation number is never a year, month-year has month precision", () => {
  assert.equal(tryParseDateAt("Friday, 12 September 2023", 0)?.iso, "2023-09-12");
  assert.equal(tryParseDateAt("2023-02-30", 0), null);
  assert.equal(tryParseDateOrBareYearAt("2023/1805 applies", 0), null);
  assert.equal(tryParseDateOrBareYearAt("2030 targets", 0)?.precision, "year");
  assert.equal(tryParseDateAt("March 2029", 0)?.precision, "month");
  assert.equal(locateCalendarDate("due on 3 April 2027 at the latest")?.iso, "2027-04-03");
  assert.equal(locateCalendarDate("no date here, only the year 2027"), null);
});

test("a bare-year `by` with no deontic or aim word is a skip with a reason, never a guessed kind; an aim word makes it `other`", () => {
  const skipped = ev("The report is dated by 2030.");
  assert.equal(skipped.hits.length, 0);
  assert.match(skipped.skips[0]?.reason ?? "", /no deontic/);
  assert.equal(ev("The Union aims to cut emissions by 2040.").hits[0]?.kind, "other");
});

test("`shall apply from X to Y` emits the window end as `other`; `for <segment>` and transitional language reclassify to phase_step", () => {
  const { hits } = ev("This Regulation shall apply from 1 January 2030 to 31 December 2034.");
  assert.deepEqual(hits.map((h) => [h.kind, h.iso]), [["entry_into_force", "2030-01-01"], ["other", "2034-12-31"]]);
  assert.equal(ev("By 1 May 2029, for container ships, operators shall register.").hits[0]?.kind, "phase_step");
  assert.equal(ev("During the transitional period, operators shall report no later than 1 May 2029.").hits[0]?.kind, "phase_step");
});

test("`By <date>, ... report` wins over the generic deadline", () => {
  assert.equal(ev("By 1 May 2029, the Commission shall report to the Parliament.").hits[0]?.kind, "review_or_report");
});

test("the reference-date refusal, with and without a commencement verb; the status-only refusal; as-of needs a deontic clause", () => {
  const run = ["2026-10-02"];
  const refused = ev("Operators must comply. Data as of 2 October 2026 shows growth.", { referenceDates: run });
  assert.equal(refused.hits.length, 0);
  assert.ok(ev("The Regulation enters into force on 2 October 2026.", { referenceDates: run }).hits.length === 1);
  assert.equal(ev("In force as of 5 May 2027. Operators shall file.", { referenceDates: [] }).hits.length, 0);
  assert.equal(ev("Operators are listed as of 5 May 2027.").hits.length, 0);
  assert.equal(ev("As of 5 May 2027, operators shall register.").hits.length, 1);
  assert.equal(ev("Data is not available as of 5 May 2027, and operators shall file.").hits.length, 0);
});

test("the FACT wrapper is unwrapped to the quoted passage containing the date (guillemets, nested, straight); a date outside the quote is a named skip", () => {
  const around = (text: string, date = "30 April 2022") => {
    const s = text.indexOf(date);
    return clauseAround(text, s, s + date.length, undefined, undefined, date);
  };
  const guillemets = "[due_date] The captured source states a due date (date_precision: day), verbatim: «By 30 April 2022, the operator shall publish»";
  assert.deepEqual(around(guillemets), { text: "By 30 April 2022, the operator shall publish…" });
  assert.deepEqual(around("[due_date] The captured source states, verbatim: «outer «By 30 April 2022» tail»"), { text: "By 30 April 2022…" });
  assert.deepEqual(around('[due_date] The captured source states, verbatim: "By 30 April 2022, shall publish"'), { text: "By 30 April 2022, shall publish…" });
  assert.deepEqual(clauseAround(guillemets, 0, 2, undefined, undefined, "[d"), { skip: "record_facts_template_date_not_in_quote" });
});

test("a due-date slot rescue has three outcomes, and a slot span with no calendar date is a named skip", () => {
  const slot = (span: string, context?: { before: string; after: string }): ClaimIn => ({ claim_id: "c1", kind: "FACT", text: `[due_date] The captured source states a due date (date_precision: day), verbatim: «${span}»`, span, ...(context ? { context } : {}) });
  assert.equal(extractForwardEvents({ claims: [slot("within 30 days of the notice")], sections: [] }).skipped[0]?.reason, "relative_deadline_no_calendar_date");
  assert.equal(extractForwardEvents({ claims: [slot("by 2030 the industry will grow")], sections: [] }).skipped.at(-1)?.reason, "calendar_date_deontic_context_unavailable");
  const rescued = extractForwardEvents({ claims: [slot("by 2030", { before: "Operators ", after: " shall reduce emissions to zero." })], sections: [] });
  assert.equal(rescued.events[0]?.event_kind, "compliance_deadline");
  assert.equal(rescued.events[0]?.date_precision, "day");
  assert.equal(extractForwardEvents({ claims: [slot("by 2030", { before: "The industry grows ", after: " in a market." })], sections: [] }).skipped.at(-1)?.reason, "calendar_date_no_deontic_in_context");
  assert.equal(needsDueDateContext(slot("by 2030 the industry will grow")), true);
  assert.equal(needsDueDateContext(slot("By 31 December 2025, the Commission shall review")), false);
  assert.equal(needsDueDateContext(slot("within 30 days")), false);
});

test("the finer of the slot's and the extractor's precision wins, never quarter", () => {
  const claim: ClaimIn = { claim_id: "c2", kind: "FACT", text: "[due_date] The captured source states a due date (date_precision: quarter), verbatim: «By 2030, operators shall register»", span: "By 2030, operators shall register" };
  assert.equal(extractForwardEvents({ claims: [claim], sections: [] }).events[0]?.date_precision, "year");
});

test("dedupe keeps the claim-backed hit over the section-backed one and records every drop with its reason", () => {
  const base = { event_date: "2030-01-01", date_precision: "day", event_kind: "entry_into_force" as const, obligation_text: "The Regulation shall enter into force on 1 January 2030 across all Member States of the Union.", source_span: "1 January 2030", extractor_version: EXTRACTOR_VERSION };
  const section = { ...base, source_kind: "section" as const, source_claim_id: null, source_section_id: "s1", confidence: "medium" as const };
  const claim = { ...base, source_kind: "claim" as const, source_claim_id: "c1", source_section_id: null, confidence: "high" as const };
  const r = dedupeEvents([section, claim]);
  assert.deepEqual(r.events.map((e) => e.source_kind), ["claim"]);
  assert.equal(r.dropped[0]?.reason, "claim_backed_preferred_over_section_backed");
  const both = dedupeEvents([claim, { ...claim, source_claim_id: "c2" }]);
  assert.equal(both.dropped[0]?.reason, "duplicate_same_confidence_kept_first");
  const distinct = dedupeEvents([{ ...claim, obligation_text: "short a" }, { ...claim, source_claim_id: "c2", obligation_text: "short b" }]);
  assert.deepEqual([distinct.events.length, distinct.dropped.length], [2, 0], "two different short obligations on one date are two events");
});

test("normalizeObligationText is idempotent; a table row is read as its explaining cell; assertVerbatim throws on a non-verbatim span", () => {
  for (const raw of ["**Deadline:** FACT: By 1 May 2029, operators shall register https://x.example/a", "| 1 May 2029 | Operators shall register their ships with the registry | ref |", "lower case start without end"]) {
    const once = normalizeObligationText(raw, { dateSpan: "1 May 2029" });
    assert.equal(normalizeObligationText(once, { dateSpan: "1 May 2029" }), once, raw);
  }
  const row = "| 1 May 2029 | Operators shall register their ships | x |";
  assert.deepEqual(clauseAround(row, row.indexOf("1 May 2029"), row.indexOf("1 May 2029") + 10, undefined, undefined, "1 May 2029"), { text: "Operators shall register their ships…" });
  assert.throws(() => assertVerbatim("abc", "abd"), /not a substring/);
  assert.throws(() => assertVerbatim("abc", ""), /empty/);
});

test("a claim with no span and a section with no text are recorded, never dropped silently (INV-218)", () => {
  const r = extractForwardEvents({ claims: [{ claim_id: "c9", kind: "FACT", text: "x", span: null }], sections: [{ section_id: "s9", md: "" }] });
  assert.deepEqual(r.skipped.map((s) => s.reason), ["claim_has_no_span", "section_has_no_text"]);
});

test("the extractor is pure: it imports no client, no network, no model", () => {
  for (const f of ["date-grammar", "window", "rules", "scan", "dedupe", "extract-forward-events"]) {
    const src = readFileSync(new URL(`../../src/features/obligations/extract/${f}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /from "@\/core\/db|supabase|fetch\(|anthropic|openai/i, f);
  }
});
