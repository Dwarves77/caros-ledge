// ROWS-1 (operator look ruling 2026-10-26, ruling 18): INV-ROWS-1 (a row draws only the fields row-fields.json names), -2 (three lines: the structure here, the measured line counts at 375 in tests/ux/list-invariants.mjs through the UX smokes),
// -3 (the short name is built only from act-heads tokens and the title's own words), -4 (the detail header shows the full official title once and keeps every field that left the row), -5 (one row component owner).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createElement } from "react";

import { normalizeDisplayTitle } from "@/core/fetch/titles";
import { BAND_ORDER } from "@/core/lists";
import heads from "@/core/lists/data/act-heads.json";
import { displayTitle as shortName0 } from "@/core/lists/display-title";
import { ListRow } from "@/ui/ListRow";
import rowFields from "@/ui/list-surface/data/row-fields.json";

import { renderApp, textOf } from "../_support/render.ts";
import { memberWorld } from "../_support/sweep-worlds.ts";

const shortName = (title: string): string => shortName0(title, true);
const ROW_TYPES = Object.keys(rowFields.rowTypes);
const count = (html: string, needle: string): number => html.split(needle).length - 1;
const ITEM_TYPE_OF: Record<string, string> = { instrument: "regulation", publication: "guidance", market_signal: "market_signal", research_finding: "research_finding", operations_profile: "regional_data", post: "post", reference: "reference" };
const FULL = { jurisdiction: "EU", due: { label: "Nov 1, 2026", days: "17 days" }, tier: 2, change: "updated_timeline", group: "Rotterdam port users", summary: "A stored plain line about what this is." };
// Everything the old row drew and the new one must not: funding tags, a "+2" count, a secondary label, a long description, the impact, the timeline, bias tags, the grade, a workspace tag, the meta line and the kind tag.
const EXTRAS = {
  tags: [{ id: "t1", name: "Q4 audit" }],
  biasTags: [{ dimension: "funding", tag: "industry-funded", confidence: 0.9 }, { dimension: "methodology", tag: "peer-reviewed", confidence: 0.9 }],
  fundingTag: "Funded by the Mobility Fund",
  moreCount: "+2",
  secondaryLabel: "Secondary label text",
  description: "A long description paragraph that must never be a row.",
  impact: { cost: 3, compliance: 2, client: 1, operational: 2 },
  timeline: [{ date: "2026-11-01", label: "Milestone one" }],
  itemGrade: "record",
  meta: "regulation · air · carbon",
  kind: "Law",
  subtitle: "Includes Annex IIa",
};
const draw = (over: Record<string, unknown>): string => renderApp(createElement(ListRow, { band: BAND_ORDER[0]!, title: "Fixture title", ...over } as never));

test("INV-ROWS-1: every row type draws exactly the fields row-fields.json lists for it, in that order, and nothing a fixture item carries beyond them", () => {
  assert.deepEqual([...ROW_TYPES].sort(), Object.keys(ITEM_TYPE_OF).sort(), "every row type has a case here");
  const types = rowFields.rowTypes as Record<string, { meta: string[] }>;
  for (const type of ROW_TYPES) {
    const itemType = ITEM_TYPE_OF[type]!;
    const html = draw({ itemType, ...FULL, ...EXTRAS });
    const text = textOf(html);
    for (const extra of ["Q4 audit", "Industry funded", "Funded by", "+2", "Secondary label", "A long description", "Milestone one", "Catalogue record", "regulation · air", "Law", "Includes Annex", "industry-funded"]) assert.ok(!text.includes(extra), `${type}: "${extra}" is on the row`);
    for (const part of ["cl-impact", "cl-tl-", "cl-bias", "cl-workspace-tag", "cl-grade"]) assert.equal(count(html, part), 0, `${type}: ${part}`);
    const hasTypeWord = itemType !== "reference" && itemType !== "post";
    const present: Record<string, boolean> = { jurisdiction: true, type: hasTypeWord, due: true, tier: true, change: true, group: true };
    const expected = types[type]!.meta.filter((k) => present[k]);
    const drawn = [...html.matchAll(/data-field="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(drawn, expected, `${type}: the meta fields drawn`);
    assert.equal(count(html, 'class="cl-row-title"'), 1, `${type}: one title`);
    assert.equal(count(html, 'class="cl-row-summary"'), 1, `${type}: one stored line`);
    assert.equal(count(html, 'class="cl-row-meta"'), 1, `${type}: one meta line`);
  }
});

test("INV-ROWS-1: the instrument row reads title, stored line, then jurisdiction, type, date with days, tier; an absent jurisdiction draws no chip and no dash, an absent date or tier the one quiet dash, an unread date nothing", () => {
  const text = textOf(draw({ itemType: "regulation", jurisdiction: "EU", title: "Directive 2000/53/EC of the European Parliament and of the Council of 18 September 2000 on end-of life vehicles", summary: "Sets recovery targets for scrapped cars.", due: { label: "Nov 1, 2026", days: "17 days" }, tier: 1 }));
  assert.equal(text, "Directive 2000/53/EC on end-of life vehicles Sets recovery targets for scrapped cars. EU Regulation Nov 1, 2026 · 17 days T1");
  const none = draw({ itemType: "regulation", jurisdiction: "", due: null, tier: null });
  assert.equal(count(none, 'data-field="jurisdiction"'), 0);
  assert.equal(count(none, 'data-absence="dash"'), 2, "the date and the tier each draw the one dash");
  assert.equal(count(draw({ itemType: "regulation", jurisdiction: null }), 'data-absence="dash"'), 0, "a surface that reads neither date nor tier draws no dash");
  assert.equal(count(draw({ itemType: "regulation", summary: null }), "cl-row-summary"), 0, "no stored line, no line");
  assert.equal(count(draw({ itemType: "regulation", change: "new" }), ">New<"), 1, "the dashboard's change kind is a token chip");
  assert.equal(count(draw({ itemType: "regulation", change: "updated_brief" }), ">Updated: brief<"), 1);
});

test("INV-ROWS-1: the change labels come from row-fields.json; an unknown change key draws nothing; the row type follows the stored item type", () => {
  assert.deepEqual(rowFields.fields.change.labels, { new: "New", updated_brief: "Updated: brief", updated_timeline: "Updated: timeline" });
  assert.equal(count(draw({ itemType: "regulation", change: "bogus" }), 'data-field="change"'), 0);
  const fields = (itemType: string | null): string[] => [...draw({ itemType, ...FULL }).matchAll(/data-field="([a-z]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(fields("regulation"), ["jurisdiction", "type", "due", "tier", "change"]);
  assert.deepEqual(fields("nonsense"), ["jurisdiction", "due", "tier", "change"], "an unknown stored type takes the default row type and draws no type chip");
  assert.deepEqual(fields(null), fields("nonsense"));
  assert.deepEqual(fields("post"), ["group"], "a row type names its own fields");
});

const SUBJECT_CASES: [string, string][] = [
  ["REGULATION (EC) No 1013/2006 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL of 14 June 2006 on shipments of waste ANNEX IA ANNEX IB", "Regulation (EC) No 1013/2006 on shipments of waste"],
  ["REGULATION (EU) 2024/573 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL of 7 February 2024 on fluorinated greenhouse gases (Text with EEA relevance) ANNEX", "Regulation (EU) 2024/573 on fluorinated greenhouse gases"],
  ["Directive 2000/53/EC of the European Parliament and of the Council of 18 September 2000 on end-of life vehicles", "Directive 2000/53/EC on end-of life vehicles"],
  ["COMMISSION DECISION of 26 March 2013 on determining Member States’ annual emission allocations", "Commission Decision of 26 March 2013 on determining Member States’ annual emission allocations"],
  ["COMMISSION IMPLEMENTING REGULATION (EU) 2018/2067 of 19 December 2018 on the verification of data, amending Regulation (EU) 2015/757", "Implementing Regulation (EU) 2018/2067 on the verification of data"],
  ["COMMISSION REGULATION (EU) No 100/2013 of 1 February 2013 on a thing, and repealing Regulation (EU) 1/2000", "Regulation (EU) No 100/2013 on a thing"],
  // no "on <subject>" after the date: the head alone (the amending tail is never the name)
  ["COMMISSION IMPLEMENTING REGULATION (EU) 2023/2122 of 12 October 2023 amending Implementing Regulation (EU) 2018/2066 as regards updating the monitoring (Text with EEA relevance) ‘ANNEX IIa Tier definitions ANNEX Xb Reports", "Implementing Regulation (EU) 2023/2122"],
  // no head: unchanged, a planted non-EU title, an empty string
  ["Air Plan Approval; Pennsylvania; Interim Final Determination for Redesignation of the Pittsburgh Area", "Air Plan Approval; Pennsylvania; Interim Final Determination for Redesignation of the Pittsburgh Area"],
  ["California SB 261 — Climate-Related Financial Risk Act", "California SB 261 — Climate-Related Financial Risk Act"],
  ["", ""],
];

test("INV-ROWS-3: the short name is the act head plus the subject clause of the title's own grammar, cut at ', amending', ', and repealing', '(Text with' and any annex; a title with no head passes through; no annex garbage ever shows", () => {
  for (const [stored, expected] of SUBJECT_CASES) assert.equal(shortName(stored), expected, stored.slice(0, 60));
  for (const [stored] of SUBJECT_CASES) assert.doesNotMatch(shortName(stored), /ANNEX|Text with|, amending|, and repealing/);
});

test("INV-ROWS-3: shortName writes no sentence: every word is in the act-type vocabulary or in the title itself, in the title's order", () => {
  const vocab = new Set([...heads.issuers.flatMap((s) => s.split(" ")), ...heads.qualifiers, ...heads.types, ...heads.legalBases.map((b) => `(${b})`), heads.numberWord, heads.dateJoiner, ...heads.months]);
  for (const [stored] of SUBJECT_CASES) {
    let at = 0;
    for (const w of shortName(stored).split(" ").filter(Boolean)) {
      if (vocab.has(w)) continue;
      const i = stored.toLowerCase().indexOf(w.toLowerCase(), at);
      assert.ok(i >= 0, `${w} is not in order in ${stored.slice(0, 50)}`);
      at = i + w.length;
    }
  }
});

test("INV-ROWS-4: the detail header shows the full official title exactly once, under the short name; every field that left the row is on the detail for the same item", async () => {
  const w = memberWorld();
  const official = "COMMISSION IMPLEMENTING REGULATION (EU) 2023/2122 of 12 October 2023 on the monitoring and reporting of greenhouse gas emissions (Text with EEA relevance)";
  Object.assign(w.db.rows("intelligence_items").find((r) => r.legacy_id === "o3")!, { title: official, item_grade: "record", compliance_deadline: "2026-12-01" });
  const html = renderApp((await (await import("@/features/regulations/pages")).RegulationDetailRoute({ params: Promise.resolve({ slug: "o3" }) })) as never, { path: "/regulations/o3" });
  const text = textOf(html);
  assert.equal(text.split(normalizeDisplayTitle(official).title).length - 1, 1, "the official title once");
  assert.match(html, /<h1[^>]*>Implementing Regulation \(EU\) 2023\/2122 on the monitoring and reporting of greenhouse gas emissions<\/h1>/, "the page title is the short name");
  for (const moved of ["Impact assessment", "Timeline", "Source tier", "Tag", "Application date"]) assert.ok(text.includes(moved), `${moved} is on the detail`);
  assert.equal(count(html, 'data-part="chip-grade"'), 1, "the grade chip moved to the detail header");
});

test("INV-ROWS-4: a detail title with no short form is the page title once, as stored", async () => {
  const w = memberWorld();
  Object.assign(w.db.rows("intelligence_items").find((r) => r.legacy_id === "o3")!, { title: "FuelEU Maritime" });
  const text = textOf(renderApp((await (await import("@/features/regulations/pages")).RegulationDetailRoute({ params: Promise.resolve({ slug: "o3" }) })) as never, { path: "/regulations/o3" }));
  assert.equal(text.split("FuelEU Maritime").length - 1, 1);
});

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : /\.(tsx|ts|jsx|js)$/.test(n) ? [join(dir, n)] : []));
const OWNER = /^src[\\/]ui[\\/](ListRow|RowMeta)\.tsx$/;

test("INV-ROWS-5: one row component owner: no file under src draws row markup (a cl-list-row or cl-row- class, a list-row part) except src/ui/ListRow.tsx and its meta line", () => {
  const markup = /className=\{?["'`][^"'`]*\bcl-(list-row|row-)[a-z-]*|data-part="list-row"/;
  assert.deepEqual(files("src").filter((f) => !OWNER.test(f) && markup.test(readFileSync(f, "utf8"))), []);
});
