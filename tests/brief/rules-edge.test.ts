import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { namesLacking, REGISTRY, severityToken, validateBrief, type BriefModel, type ItemColumns } from "@/core/brief/rules";
import { tokenHash } from "@/core/contracts/token-hash";

import { fixtureRow, run, ruleTests } from "./_cases.ts";

const clean = fixtureRow("clean-market");
const withBody = (body: string): BriefModel => ({ ...clean.brief, body });
const withItem = (over: Partial<ItemColumns>): ItemColumns => ({ ...clean.item, ...over });

test("the severity rules behave the same on a batch entry's display label and on a stored token (the scope reviewer's note: normalise through toDbSeverity)", () => {
  assert.equal(severityToken("COST ALERT"), "cost_alert");
  assert.equal(severityToken("cost_alert"), "cost_alert");
  assert.equal(severityToken(null), null);
  assert.equal(severityToken("reference"), "reference", "a value outside the five is kept as written (validateMetadata names it)");
  for (const rule of ["severity-present", "priority-follows-map", "banner-matches-column"]) {
    assert.deepEqual(run(rule, clean.brief, withItem({ severity: severityToken("COST ALERT") })), run(rule, clean.brief, withItem({ severity: "cost_alert" })), rule);
  }
  assert.equal(run("priority-follows-map", clean.brief, withItem({ severity: "COST ALERT" }))?.rule ?? null, null, "an unnormalised label maps to no priority, so the map has nothing to lock");
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

// One planted violation and one clean twin per registered rule (the per-rule files of tests/brief/rules are folded into this file).
for (const r of REGISTRY) ruleTests(r.id);

// ---- moved from tests/brief/rules/dash-outside-verbatim.test.ts (LOCK-NO-BLOAT-1)
{
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
}

// ---- moved from tests/brief/rules/forward-events-covered.test.ts (LOCK-NO-BLOAT-1)
{
  const base = fixtureRow("forward-events-covered");
  const D = "2031-02-03";
  const go = (b: Record<string, unknown>) => run("forward-events-covered", { ...base.brief, ...b }, base.item);

  test("forward-events-covered: a supplied date missing from the entry is residue naming the rule", () => assert.equal(go({})?.rule, "forward-events-covered"));
  test("forward-events-covered: the date in the events block passes", () => assert.equal(go({ events: [D] }), null));
  test("forward-events-covered: the date quoted in a section passes", () => assert.equal(go({ body: `${base.brief.body}\n\nThe step falls on ${D}.` }), null));
  test("forward-events-covered: a stated reason for omitting passes, a blank reason does not", () => {
    assert.equal(go({ omitted: [{ date: D, reason: "the source gives it as a meeting, not an event" }] }), null);
    assert.equal(go({ omitted: [{ date: D, reason: "  " }] })?.rule, "forward-events-covered");
  });
  test("forward-events-covered: an item with no supplied events passes", () => assert.equal(run("forward-events-covered", base.brief, { ...base.item, supplied_dates: [] }), null));

  // Precision (PR 139): a month-precision row (stored YYYY-MM-01) arrives as the key YYYY-MM and a year-precision row (YYYY-01-01) as YYYY.
  const at = (key: string, b: Record<string, unknown>) => run("forward-events-covered", { ...base.brief, ...b }, { ...base.item, supplied_dates: [key] });
  test("forward-events-covered: a month-precision date is covered by an events entry of that month and precision, by the month and year in a section, or by an omitted_events entry; the day alone does not cover it", () => {
    assert.equal(at("2031-02", {})?.rule, "forward-events-covered");
    assert.equal(at("2031-02", { events: ["2031-02"] }), null);
    assert.equal(at("2031-02", { events: ["2031-02-03"] })?.rule, "forward-events-covered");
    assert.equal(at("2031-02", { body: `${base.brief.body}

  The step falls in February 2031.` }), null);
    assert.equal(at("2031-02", { omitted: [{ date: "2031-02-01", reason: "a meeting, not an event" }] }), null);
  });
  test("forward-events-covered: a year-precision date is covered by an events entry of that year and precision, by the year in a section, or by an omitted_events entry", () => {
    assert.equal(at("2031", {})?.rule, "forward-events-covered");
    assert.equal(at("2031", { events: ["2031"] }), null);
    assert.equal(at("2031", { events: ["2031-02"] })?.rule, "forward-events-covered");
    assert.equal(at("2031", { body: `${base.brief.body}

  The review is due during 2031.` }), null);
    assert.equal(at("2031", { omitted: [{ date: "2031-01-01", reason: "a placeholder year" }] }), null);
  });
}

// ---- moved from tests/brief/rules/workspace-or-client-named.test.ts (LOCK-NO-BLOAT-1)
{
  // The names are held only as hashes. The plant is a fictional name whose hash ships beside the real ones, so the match is proved through the hash and no test file holds a real name.
  const PLANT = "Zorblax Quillfeather";

  test("the match goes through the hash: a clear planted name is found case-insensitively, a word alone is not, and the data holds no clear name", () => {
    const data = JSON.parse(readFileSync("src/core/brief/data/workspace-names.json", "utf8")) as { hashes: string[] };
    assert.ok(data.hashes.every((h) => /^[0-9a-f]{64}$/.test(h)), "every entry is a SHA-256 hex digest");
    assert.ok(data.hashes.includes(tokenHash(PLANT)));
    const row = fixtureRow("workspace-or-client-named");
    const said = (text: string) => run("workspace-or-client-named", { ...row.brief, body: text }, row.item)?.rule ?? null;
    assert.equal(said(`Prefix text. ${PLANT.toUpperCase()} commissions crates.`), "workspace-or-client-named", "case-insensitive");
    assert.equal(said("Zorblax alone, and Quillfeather alone, are not the name."), null);
    assert.equal(said("Zorblax and Quillfeather, a clause apart."), null);
    assert.ok(row.brief.body.includes(PLANT));
    assert.equal(run("workspace-or-client-named", row.brief, row.item)?.rule, "workspace-or-client-named");
  });

  test("tokenHash is the helper tree-checks uses for its banned token", () => {
    assert.equal(tokenHash("ABC"), tokenHash("abc"));
    assert.match(readFileSync("scripts/ci/tree-checks.mjs", "utf8"), /tokenHash\(t\)/);
  });

  test("the live report's organization check names a part whose hash the list lacks, and nothing else", () => {
    const mine = new Set([tokenHash("Acme"), tokenHash("Globex")]);
    assert.deepEqual(namesLacking(["Acme / Globex"], mine), []);
    assert.deepEqual(namesLacking(["Acme / Initech"], mine), [tokenHash("Initech")]);
  });
}

test("do-now-restates-gap: the GAP claim that answers the action_now slot may carry the lead action sentence; a gap for any other slot is still refused when the do-now section restates it", () => {
  const plant = fixtureRow("do-now-restates-gap");
  const claim = plant.brief.claims[0] as NonNullable<(typeof plant.brief.claims)[0]>;
  assert.equal(run("do-now-restates-gap", plant.brief, plant.item)?.rule, "do-now-restates-gap");
  const slot = { ...plant.brief, claims: [{ ...claim, text: claim.text.replace("[start_date]", "[action_now]") }] };
  assert.equal(run("do-now-restates-gap", slot, plant.item), null);
  const both = { ...plant.brief, claims: [claim, { ...claim, text: "[action_now] Ask carriers for the schedule." }] };
  assert.equal(run("do-now-restates-gap", both, plant.item)?.rule, "do-now-restates-gap", "the exemption is the slot's own claim, not every claim of a brief that has one");
});

test("ENTITY-MINT-1: an instrument number (\"No 528/2012\", \"No. 1234\", \"Nos 1/2024\") inside the negation window of a qualification keyword is not a negation; a real \"no\" still negates", () => {
  const reg = fixtureRow("clean-regulatory");
  const key = "8"; // Substantive Requirements
  const brief = (span: string): BriefModel => ({ ...reg.brief, sections: new Map([...reg.brief.sections, [key, "Obligations surveyed: 1; workspace-adjacent: 1; extracted as FACT: 1."]]), claims: [{ kind: "FACT", section: key, span, text: span, capture: null }] });
  const item: ItemColumns = { ...reg.item, has_trajectory: true, pool_chars: 0 };
  const cited = (span: string) => run("accounting-line-present", brief(span), item)?.detail ?? null;
  assert.equal(cited("Regulation (EU) No 528/2012 applies to biocidal products; small operators are exempt."), null, "No <number> is an instrument number, not a negation of the scope and exception keywords");
  assert.equal(cited("Regulation (EU) No. 1234/2024 applies to operators; vessels under 400 GT are exempt."), null, "No. <number>");
  assert.equal(cited("Regulations (EU) Nos 1/2024 and 2/2024 apply; the scope is limited to operators; vessels under 400 GT are exempt."), null, "Nos <number>");
  assert.match(cited("Under Article 5 no exemption applies to small operators.") ?? "", /no unnegated exception.*no unnegated scope-limit/, "a real no still negates both keywords");

});
test("stored-date-stated (ruling 73): a stored date the body omits is satisfied by an omitted_events row carrying that date with a non-blank reason, and by nothing less", () => {
  const item = withItem({ compliance_deadline: "2031-06-30", entry_into_force: null });
  const omit = (o: { date: string; reason: string }[]) => run("stored-date-stated", { ...clean.brief, omitted: o }, item);
  assert.equal(run("stored-date-stated", clean.brief, item)?.rule, "stored-date-stated", "no omitted_events row: still trips");
  assert.equal(omit([{ date: "2031-06-30", reason: "no capture states this stored date" }]), null);
  assert.equal(omit([{ date: "2031-06-30", reason: "  " }])?.rule, "stored-date-stated", "a blank reason does not satisfy");
  assert.equal(omit([{ date: "2031-07-01", reason: "a different date" }])?.rule, "stored-date-stated", "another date does not satisfy");
});
