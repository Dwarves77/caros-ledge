import assert from "node:assert/strict";
import { test } from "node:test";

import { severityToken, validateBrief, type BriefModel, type ItemColumns } from "@/core/brief/rules";

import { fixtureRow, run } from "./_cases.ts";

const clean = fixtureRow("clean-market");
const withBody = (body: string): BriefModel => ({ ...clean.brief, body });
const withItem = (over: Partial<ItemColumns>): ItemColumns => ({ ...clean.item, ...over });

test("the severity rules behave the same on a batch entry's display label and on a stored token (the scope reviewer's note: normalise through toDbSeverity)", () => {
  assert.equal(severityToken("COST ALERT"), "cost_alert");
  assert.equal(severityToken("cost_alert"), "cost_alert");
  assert.equal(severityToken(null), null);
  assert.equal(severityToken("reference"), "reference", "a value outside the five is kept as written, for severity-in-vocabulary to name");
  for (const rule of ["severity-in-vocabulary", "severity-present", "priority-follows-map", "banner-matches-column"]) {
    assert.deepEqual(run(rule, clean.brief, withItem({ severity: severityToken("COST ALERT") })), run(rule, clean.brief, withItem({ severity: "cost_alert" })), rule);
  }
  assert.equal(run("severity-in-vocabulary", clean.brief, withItem({ severity: "COST ALERT" }))?.rule, "severity-in-vocabulary", "an unnormalised label is not a stored token");
});

test("banner-matches-column compares the SET of banner labels, not the first label", () => {
  const banner = (labels: string) => withBody(`## ${labels}\n\n${clean.brief.body}`);
  assert.equal(run("banner-matches-column", banner("COST ALERT"), clean.item), null);
  assert.equal(run("banner-matches-column", banner("COST ALERT | MONITORING"), clean.item)?.rule, "banner-matches-column", "a two-label banner is not the column's one label");
  assert.equal(run("banner-matches-column", banner("MONITORING"), clean.item)?.rule, "banner-matches-column");
  assert.equal(run("banner-matches-column", clean.brief, withItem({ severity: null })), null, "no banner, nothing to disagree with");
});

test("stored-date-stated accepts the renderings in data/date-renderings.json and names a date the body never writes", () => {
  const dated = (body: string, d = "2030-01-01") => run("stored-date-stated", withBody(`${clean.brief.body}\n\n${body}`), withItem({ compliance_deadline: d, entry_into_force: null }));
  for (const text of ["1 January 2030", "January 1, 2030", "2030-01-01", "January 1 2030", "Jan 1, 2030", "1st January 2030"]) assert.equal(dated(`Applies from ${text}.`), null, text);
  assert.match(dated("Applies from January 2030.")?.detail ?? "", /compliance_deadline 2030-01-01 is never written/);
  assert.equal(run("stored-date-stated", clean.brief, withItem({ entry_into_force: "2027-03-02", compliance_deadline: null }))?.rule, "stored-date-stated");
});

test("required-sections-present: a stated omission note is no row, so it does not satisfy the rule", () => {
  const sections = new Map(clean.brief.sections);
  sections.delete("4");
  assert.match(run("required-sections-present", { ...clean.brief, sections }, clean.item)?.detail ?? "", /no section 4/);
});

test("do-now-severity-label names the section, and only the sections the brief has", () => {
  const sections = new Map(clean.brief.sections);
  sections.set("7", "Ask carriers for the schedule.");
  assert.match(run("do-now-severity-label", { ...clean.brief, sections }, clean.item)?.detail ?? "", /do-now section 7/);
  sections.delete("7");
  assert.equal(run("do-now-severity-label", { ...clean.brief, sections }, clean.item), null, "a missing section is required-sections-present's finding");
});

test("topic-tags-vocabulary-and-cap names the cap and the vocabulary separately", () => {
  const over = run("topic-tags-vocabulary-and-cap", clean.brief, withItem({ topic_tags: ["emissions", "fuels", "transport", "reporting"] }));
  assert.match(over?.detail ?? "", /4 tags, cap 3/);
  assert.doesNotMatch(over?.detail ?? "", /outside the vocabulary/);
});

test("fact-span-in-own-section names a claim whose declared section is not one of the format's", () => {
  const stray = { kind: "FACT", section: "99", span: "x", text: "x", capture: "x" };
  assert.match(run("fact-span-in-own-section", { ...clean.brief, claims: [stray] }, clean.item)?.detail ?? "", /claims\[0\]: section "99" is not a canonical section key/);
});

test("validateBrief splits the violations by the registry row: a refuse rule and a residue rule on one brief land in their own lists", () => {
  const brief = withBody(`${clean.brief.body}\n\nPer the 2026 outlook — as of the date of generation.`);
  const { refuse, residue } = validateBrief(brief, clean.item);
  assert.deepEqual(refuse.map((v) => v.rule), ["dash-outside-verbatim"]);
  assert.deepEqual(residue.map((v) => v.rule), ["as-of-has-date"]);
  assert.deepEqual(validateBrief(clean.brief, clean.item), { refuse: [], residue: [] });
});
