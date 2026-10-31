// UI-RADAR-1 (2026-10-31, ruling 41): the customer pages say why two things are connected, in plain words, and show the cross-surface patterns the engine found. One test per invariant:
// INV-1 no customer component renders an edge score, a method id, a uuid or a raw token (a data-driven pass over every surface the brief touches); INV-2 every rendered connection has a non-empty reason sentence;
// INV-3 the radar draws N patterns from N emerging rows, none (and the empty state) with none; INV-4 a stale theme brief with under half its members left is not drawn, the composed line is; INV-5 every list and dashboard row has a second line;
// INV-6 the radar and the figure lines keep the 44 px target of law 2; and the forming chains, "Why this matters" and "What moves with this" lines the addendum adds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createElement } from "react";

import { buildConnectionRows, buildSupersessionRows, linkedByWords, movesRows, reasonFor, whyLines, type ConnectionIn, type FactLink } from "@/core/flywheel/view-model";
import { toListRowFields } from "@/core/lists/row-fields";
import { themeAnalysisView } from "@/core/themes/theme-view";
import { isOperationsFigure } from "@/features/operations/model/derived-view";
import { readFlywheelRadar, readWhyMatters, type FactsJoin, type RadarView } from "@/features/flywheel/radar/read";
import { DerivedFigures } from "@/features/operations/ui/Spec09Panels";
import { CrossPageSection } from "@/ui/detail/CrossPageSection";
import { ItemConnections } from "@/ui/detail/ItemConnections";
import { FlywheelRadar, WhyMatters } from "@/ui/flywheel/FlywheelRadar";
import { ThemeStrip } from "@/ui/list-surface/ThemeStrip";

import { memoryDb } from "../_support/memory-db.ts";
import { renderApp, textOf } from "../_support/render.ts";

const LOOKUP = Object.fromEntries(["a", "b", "c", "d", "e"].map((id) => [id, { id, title: `Item ${id.toUpperCase()}`, priority: "HIGH" }]));
const SRC = { signal: "shared_source", detail: "grounded in the same source", weight: 0.4 };
const SCN = { signal: "shared_scenario", detail: "both touch ocean-fuel-surcharge", weight: 0.3 };
const ENT = { signal: "shared_entity", detail: "both name reg:2023/959", weight: 0.85 };
const edge = (id: string, over: Partial<ConnectionIn> = {}): ConnectionIn => ({ id, uuid: `uuid-${id}`, relationship: "related", direction: "outgoing", surface: "market", origin: "provenance_discovery", score: 0.69, ...over });
const link = (refTable: string, summary: FactLink["summary"], over: Partial<FactLink> = {}): FactLink => ({ refTable, refId: `${refTable}-1`, entity: { id: "e1", kind: "material", canonicalName: "Heavy fuel oil" }, hop: 0, surface: "market", summary, ...over });
const HFO = link("market_series", { label: "Heavy fuel oil 3.5%S", delta: { window: "1w", pct: 24.8 } });
const ETS = link("statutory_computations", { date: "2027-01-01", dutyHolder: "ocean carriers", penalty: "EUR 100/t excess emissions" }, { entity: { id: "e2", kind: "instrument", canonicalName: "Directive 2023/959" }, surface: "regulations" });

test("INV-2: every rendered connection carries a plain reason, whatever the basis it came from", () => {
  const rows = buildConnectionRows(
    [edge("a", { basis: [SRC, SCN] }), edge("b", { basis: [ENT, SRC] }), edge("c", { basis: { evidence: [{ signal: "coupled_entity", entities: [{ canonicalName: "Methanol" }, { canonicalName: "Container shipping" }], relation: "fuel_for_mode" }] } }), edge("d", { origin: "manual", basis: null, relationship: "supersedes" }), edge("e", { origin: "entity_extraction", basis: null })],
    LOOKUP,
  );
  assert.equal(rows.length, 5);
  for (const r of rows) assert.ok(r.reason.trim().length > 10, `${r.id}: ${r.reason}`);
  const by = Object.fromEntries(rows.map((r) => [r.id, r.reason]));
  assert.equal(by.a, "Shared operating context: ocean fuel surcharge.", "the tag-level sentence is the last fallback, in words");
  assert.equal(by.b, "Both concern 2023/959.", "an entity beats the same source");
  assert.equal(by.c, "Methanol fuels Container shipping, so a change in one reaches the other.");
  assert.equal(by.d, "Replaces prior statutory provisions.");
  assert.equal(by.e, "Cited directly in the source text.");
});

test("a same-source-only edge is not a connection, and a candidate edge is not in the connection list", () => {
  const rows = buildConnectionRows([edge("a", { basis: [SRC] }), edge("b", { origin: "candidate", basis: { evidence: [SCN], missing: { surface: "operations", truth: "an Operations grid-queue figure for Rotterdam", patternFamily: "mandateCapacity" } } })], LOOKUP);
  assert.deepEqual(rows.map((r) => r.id), ["b"], "the source-only edge is dropped");
  assert.equal(rows[0]?.developing?.family, "Mandate vs capacity collision forming");
  assert.equal(rows[0]?.developing?.next, "an Operations grid-queue figure for Rotterdam");
  const html = renderApp(createElement(ItemConnections, { rows }));
  assert.match(textOf(html), /Developing/);
  assert.match(textOf(html), /Next link to watch: an Operations grid-queue figure for Rotterdam/);
  assert.doesNotMatch(textOf(html), /Connections/, "the developing chain is not listed as a connection");
});

test("a reason states the causal chain from the facts of the two items, the reader's rationale first", () => {
  const withFacts = buildConnectionRows([edge("a", { basis: [SCN] })], LOOKUP, { self: [ETS], facts: new Map([["uuid-a", [HFO]]]) });
  assert.equal(withFacts[0]?.reason, "Directive 2023/959 binds ocean carriers from Jan 1, 2027 (penalty EUR 100/t excess emissions). Heavy fuel oil 3.5%S rose 24.8% over the last week.");
  const authored = buildConnectionRows([edge("a", { basis: { evidence: [SCN], rationale: { text: "Both costs land on the same voyage and reach forwarders as surcharge." } } })], LOOKUP, { self: [ETS], facts: new Map([["uuid-a", [HFO]]]) });
  assert.equal(authored[0]?.reason, "Both costs land on the same voyage and reach forwarders as surcharge.");
  assert.equal(reasonFor({ basis: null, origin: "manual", label: "Related" }), null, "a reason is never invented");
  assert.deepEqual(buildSupersessionRows([{ old: "a", new: "self" }], "self", LOOKUP).map((r) => r.reason), ["Replaces prior statutory provisions."]);
});

test("INV-1: no surface the brief touches renders an edge score, a method id, a uuid or a raw token", () => {
  const rows = buildConnectionRows([edge("a", { basis: [SRC, SCN] }), edge("b", { basis: [ENT] }), edge("c", { basis: [{ signal: "intersection", detail: { scenarios: ["ocean-fuel-surcharge"], objects: ["eu-ets"], strength: 9, tier: "strong" } }] }), edge("d", { origin: "candidate", basis: { evidence: [SCN], missing: { surface: "research", truth: "a Research abatement-cost evaluation for methanol engines", patternFamily: "pattern_penalty_abatement" } } })], LOOKUP);
  const view: RadarView = {
    patterns: [{ key: "00000000-0000-4000-8000-000000000001", label: "Mandate vs. capacity collision", means: "A rule requires something by a date.", forming: false, groups: [{ surface: "regulations", label: "Regulations", href: "/regulations", items: [{ title: "FuelEU Maritime", href: "/regulations/x" }], names: [] }], watch: "Watch: confirmed while the evidence behind it keeps holding.", missingParts: [], next: null }],
    forming: [{ key: "f", family: "Economic/abatement crossover forming", chain: [{ title: "Item A", href: "/market/a", surface: "market" }], reason: "Shared operating context: ocean fuel surcharge.", next: null }],
  };
  const theme = { memberCount: 3, pages: [{ surface: "market", label: "Market Intel" }], hasBrief: false, title: null, stale: false, supersedesThemeId: null, briefMd: null, sections: null, forwardOutlook: { horizons: [] }, membersByPage: [], cluster: { memberIds: [], pivotIds: [], surfaces: ["market"], linkedBy: ["Directive 2023/959"], memberCount: 3, surfaceCount: 1, density: 0.82 }, ramificationsMissing: false };
  const surfaces: Record<string, string> = {
    connections: renderApp(createElement(ItemConnections, { rows })),
    radar: renderApp(createElement(FlywheelRadar, { view })),
    strip: renderApp(createElement(ThemeStrip, { chips: [], radar: view })),
    cross: renderApp(createElement(CrossPageSection, { surfaceKey: "market", surfaceLabel: "Market Intel", crossPage: { theme, radar: view, moves: movesRows([HFO, ETS]) } as never })),
    figures: renderApp(createElement(DerivedFigures, { figures: [{ valueId: "00000000-0000-4000-8000-000000000009", title: "One-week movement · EUR/USD", value: 0.05, unit: "USD/EUR", currency: "USD", originClass: "Derived", lifecycle: "verified", confidence: 0.9, computedAt: "2026-10-15T12:00:00Z", previous: 0.03, inputs: [{ label: "EUR/USD", period: "2026-10-15", sourceName: "ECB", tier: 1 }], tier: 1, why: whyLines([ETS], "EUR/USD") }] })),
  };
  const banned: [string, RegExp][] = [["a uuid", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i], ["a method id", /pattern_[a-z_]+/], ["an evidence kind", /\b(?:shared|coupled)_[a-z_]+/], ["a score", /(?:·|score|weight)\s*:?\s*0\.\d{2}\b/i], ["a kebab token", /\b[a-z]+-[a-z]+-[a-z]+\b/]];
  for (const [name, html] of Object.entries(surfaces)) {
    const text = textOf(html);
    assert.ok(text.length > 20, `${name} drew something`);
    for (const [what, rx] of banned) assert.doesNotMatch(text, rx, `${name} shows ${what}`);
  }
});

// -- INV-3: the radar over the stored rows ----------------------------------------------------------------------------------------------------------
const ITEM = (id: string, title: string, type = "regulation", domain = 1) => ({ id, legacy_id: null, title, item_type: type, domain, provenance_status: "verified", is_archived: false, replaced_by: null });
const PATTERN = (n: number, over: Record<string, unknown> = {}) => ({
  value_id: `v${n}`, entity_id: `anchor${n}`, method_id: "pattern_mandate_capacity", method_version: "1.4.0", lifecycle: "emerging", computed_by: `pattern_mandate_capacity@1.4.0:k${n}`, computed_at: `2026-10-0${n}T00:00:00Z`, admissibility: "calculation_ok",
  inputs: [{ table: "obligation_objects", pk: `ob${n}`, kind: "key", surface: "regulations", entities: ["e1"] }, { table: "grid_connection_queues", pk: `q${n}`, kind: "member", surface: "operations", entities: ["e2"] }], ...over,
});
const worldOf = (n: number, extra: Record<string, unknown[]> = {}) => memoryDb({
  derived_values: Array.from({ length: n }, (_, i) => PATTERN(i + 1)),
  obligation_objects: Array.from({ length: n }, (_, i) => ({ obligation_id: `ob${i + 1}`, instrument_item_id: `i${i + 1}` })),
  intelligence_items: Array.from({ length: n }, (_, i) => ITEM(`i${i + 1}`, `FuelEU Maritime ${i + 1}`)),
  entities: [{ entity_id: "e1", canonical_name: "Shore power" }, { entity_id: "e2", canonical_name: "Rotterdam grid connection queue" }],
  ...extra,
}).db;

test("INV-3: the radar draws N patterns from N emerging rows, and none, with the empty state, from none", async () => {
  for (const n of [1, 3]) {
    const view = await readFlywheelRadar({ db: worldOf(n), admin: worldOf(n) }, { kind: "corpus" });
    assert.equal(view.patterns.length, n);
    const html = renderApp(createElement(FlywheelRadar, { view }));
    assert.equal(html.split('data-part="radar-pattern"').length - 1, n);
    assert.match(textOf(html), /Mandate vs\. capacity collision/);
    assert.match(textOf(html), /Regulations ?: FuelEU Maritime 1/);
    assert.match(textOf(html), /Operations ?: Rotterdam grid connection queue/, "a surface with no item is named by its entities");
  }
  const none = await readFlywheelRadar({ db: worldOf(0), admin: worldOf(0) }, { kind: "corpus" });
  assert.deepEqual(none, { patterns: [], forming: [] });
  assert.match(textOf(renderApp(createElement(FlywheelRadar, { view: none }))), /No cross-surface pattern has formed yet in this scope\./);
  assert.match(textOf(renderApp(createElement(FlywheelRadar, { view: null }))), /did not load/, "a failed read is said, never an empty panel");
  assert.equal(renderApp(createElement(FlywheelRadar, { view: none, quiet: true })), "", "an item with no pattern draws no panel");
});

test("the radar adds the signpost that confirms a pattern and the missing part an open need names, and scopes to a surface and an item", async () => {
  const db = worldOf(2, {
    signposts: [{ entity_id: "s1", watches: "anchor1", predicate: { op: "date_passed", pattern: "mandateCapacity:k1", key_date: "2027-01-01" }, outcome: null }, { entity_id: "s2", watches: "anchor2", predicate: { pattern: "mandateCapacity:k2" }, outcome: "refuted" }],
    integrity_flags: [{ id: "f1", subject_ref: "pattern:mandateCapacity:k1:far", description: "Pattern x names y to far. Missing vertex: a row on far. Surface market; entities far; window the last 30 days; venue class: docket.", created_by: "flywheel-gap:pattern_hop_gap", status: "open" }, { id: "f2", subject_ref: "pattern:mandateCapacity:k2:far", description: "Surface market;", created_by: "flywheel-gap:pattern_hop_gap", status: "resolved" }],
  });
  const view = await readFlywheelRadar({ db, admin: db }, { kind: "corpus" });
  const [p1, p2] = view.patterns.sort((a, b) => a.key.localeCompare(b.key));
  assert.equal(p1?.watch, "Watch: confirmed if the dated step still stands on 2027-01-01.");
  assert.equal(p2?.watch, null, "a scored signpost is not a thing to watch");
  assert.deepEqual(p1?.missingParts, ["Missing part: no Market Intel item yet; the chain is incomplete until one appears."]);
  assert.deepEqual(p2?.missingParts, [], "a resolved need is not shown");
  assert.equal((await readFlywheelRadar({ db, admin: db }, { kind: "surface", surface: "market" })).patterns.length, 0, "no pattern on the market page has a row there");
  assert.equal((await readFlywheelRadar({ db, admin: db }, { kind: "item", itemUuid: "i2", memberIds: [] })).patterns.length, 1, "an item sees the patterns it rests on");
  await assert.rejects(readFlywheelRadar({ db: memoryDb({}, { failures: [{ table: "derived_values_admissible", op: "select", message: "boom" }] }).db, admin: db }, { kind: "corpus" }), /boom/);
});

test("a pattern still forming is drawn as its family with the chain so far and the next link to watch; a candidate edge likewise", async () => {
  const db = worldOf(1, {
    derived_values: [PATTERN(1, { method_id: "pattern_penalty_abatement", lifecycle: "forming", computed_by: "pattern_penalty_abatement@1.5.0:k1", inputs: [{ table: "obligation_objects", pk: "ob1", surface: "regulations", entities: ["e1"] }, { missing: { surface: "research", truth: "a Research abatement-cost evaluation for methanol engines", entity: "e1" } }] })],
    item_cross_references: [{ id: "x1", source_item_id: "i1", target_item_id: "i2", origin: "candidate", score: 0.22, basis: { evidence: [{ signal: "shared_entity", entities: [{ canonicalName: "Methanol" }] }], missing: { surface: "market", truth: "a Market price series for e-methanol", patternFamily: "penaltyAbatement" } } }],
    intelligence_items: [ITEM("i1", "FuelEU Maritime"), ITEM("i2", "E-methanol price signal", "market_signal", 4)],
  });
  const view = await readFlywheelRadar({ db, admin: db }, { kind: "corpus" });
  assert.equal(view.patterns[0]?.label, "Economic/abatement crossover forming");
  assert.equal(view.patterns[0]?.next, "a Research abatement-cost evaluation for methanol engines");
  assert.equal(view.forming[0]?.family, "Economic/abatement crossover forming");
  assert.equal(view.forming[0]?.reason, "Both concern Methanol.");
  const text = textOf(renderApp(createElement(FlywheelRadar, { view })));
  assert.match(text, /Next link to watch: a Research abatement-cost evaluation for methanol engines/);
  assert.match(text, /Next link to watch: a Market price series for e-methanol/);
  assert.doesNotMatch(text, /0\.22|missing a tag/i);
});

// -- INV-4: the theme gate ---------------------------------------------------------------------------------------------------------------------------
const MEMBERS = ["m1", "m2", "m3", "m4"].map((id, i) => ({ id, legacy_id: id, title: `Member ${i + 1}`, item_type: i % 2 ? "market_signal" : "regulation", domain: i % 2 ? 4 : 1 }));
const THEME = { id: "t1", member_ids: ["m1", "m2", "m3", "m4"], surfaces: ["regulations", "market"], dominant_signals: [{ signal: "shared_source", weight: 3 }], density: 0.4 };
const BRIEF = (member_ids: string[]) => ({ theme_id: "t1", title: "Ship-source pollution: the 2005 discharge-and-penalty pair", brief_md: "A two-member brief from August about discharge penalties.", member_hash: "old", member_ids, sections: null });
const view = (member_ids: string[], linkedBy: string[] = []) => themeAnalysisView({ itemId: "m1", surface: "regulations", themes: [THEME], briefs: [BRIEF(member_ids)], members: MEMBERS, linkedBy, asOfIso: "2026-10-31T00:00:00Z" });

test("INV-4: a stale brief with under half its members left is not drawn, the composed line is; one that passes the gate says it was written for an earlier membership", () => {
  const gone = view(["x1", "x2", "m1"], ["Directive 2023/959", "Heavy fuel oil"]);
  assert.equal(gone?.hasBrief, false);
  const html = textOf(renderApp(createElement(CrossPageSection, { surfaceKey: "regulations", surfaceLabel: "Regulations", crossPage: { theme: gone } as never })));
  assert.match(html, /4 items across Regulations, Market Intel, linked mostly by Directive 2023\/959, Heavy fuel oil\. A written synthesis is queued\./);
  assert.doesNotMatch(html, /discharge-and-penalty|Narrative synthesis pending|Stale/);
  const kept = view(["m1", "m2", "x1"]);
  assert.equal(kept?.hasBrief, true, "two of three members remain: the brief still describes the theme");
  const keptHtml = textOf(renderApp(createElement(CrossPageSection, { surfaceKey: "regulations", surfaceLabel: "Regulations", crossPage: { theme: kept } as never })));
  assert.match(keptHtml, /discharge-and-penalty/);
  assert.match(keptHtml, /Written for an earlier membership/);
  assert.equal(view([])?.hasBrief, false, "a brief that names no members cannot be shown to describe this theme");
  assert.deepEqual(linkedByWords([[SCN, SRC], [SCN], { evidence: [{ signal: "shared_entity", entities: [{ canonicalName: "Methanol" }] }] }]), ["ocean fuel surcharge", "Methanol"], "the same source is not a link; most frequent first");
});

// -- INV-5: the second line of a row -------------------------------------------------------------------------------------------------------------------
test("INV-5: a list or dashboard row always has a second line: why it matters, else what it changes, else what it is, else a composed line", () => {
  const base = { id: "r", cat: "ocean", sub: "", title: "T", url: "", note: "", type: "regulation", priority: "HIGH", added: "2026-01-01", reasoning: "", tags: [], keyData: [], modes: [], whatIsIt: "" } as never;
  const now = new Date("2026-10-31T00:00:00Z");
  const line = (over: Record<string, unknown>) => toListRowFields({ ...(base as object), ...over } as never, now).summary;
  assert.equal(line({ whyMatters: "Carriers pay a surcharge from 2027. A second sentence.", whatIsIt: "A regulation." }), "Carriers pay a surcharge from 2027.");
  assert.equal(line({ whatItChanges: "It moves the reporting date to March. More." }), "It moves the reporting date to March.");
  assert.equal(line({ whatIsIt: "Regulation (EU) No. 2023/959 amends the ETS. Later." }), "Regulation (EU) No. 2023/959 amends the ETS.", "No. is not a sentence end");
  assert.equal(line({ jurisdiction: "EU", complianceDeadline: "2027-01-01" }), "Applies in EU; next date Jan 1, 2027.");
  assert.equal(line({}), "Applies across jurisdictions.");
});

// -- the figure lines and the moves ------------------------------------------------------------------------------------------------------------------
test("Why this matters: two lines naming the regulation with its next date and penalty and the operation tied to it; an absence names the surface that holds nothing", async () => {
  const items = [{ ...ETS, summary: { title: "Directive 2023/959", date: "2027-01-01", penalty: "EUR 100/t" } }, link("intelligence_items", { title: "Rotterdam shore-power profile" }, { surface: "operations" })];
  assert.deepEqual(whyLines(items, "heavy fuel oil"), ["Directive 2023/959: next dated obligation Jan 1, 2027, penalty EUR 100/t.", "Also tied: Rotterdam shore-power profile (Operations)."]);
  assert.deepEqual(whyLines([], "propane"), ["No regulation in the ledger is tied to propane yet.", "No operations, market or research item is tied to propane yet."]);
  const join: FactsJoin = { readEntityFacts: async () => new Map(), readFactItems: async (_db, _t, ids) => new Map(ids.map((id) => [id, id === "s1" ? items : []])) };
  const lines = await readWhyMatters(worldOf(0), join, "market_series", [{ id: "s1", subject: "HFO" }, { id: "s2", subject: "propane" }]);
  assert.equal(lines?.get("s1")?.[0], "Directive 2023/959: next dated obligation Jan 1, 2027, penalty EUR 100/t.");
  assert.match(lines?.get("s2")?.[0] ?? "", /No regulation in the ledger is tied to propane yet/);
  assert.equal(await readWhyMatters(worldOf(0), null, "market_series", [{ id: "s1", subject: "HFO" }]), null, "with no join a card draws no line: it never claims nothing is tied");
  assert.match(textOf(renderApp(createElement(WhyMatters, { lines: whyLines([], "propane") }))), /^Why this matters No regulation/);
});

test("What moves with this: each structured row tied to the item's entities as one line, the strongest kind first", () => {
  const rows = movesRows([HFO, ETS, link("oem_tech_roadmaps", { label: "Methanol dual-fuel engines", trl: 8 }, { hop: 1, entity: { id: "e3", kind: "technology", canonicalName: "Methanol" } })]);
  assert.deepEqual(rows.map((r) => r.kind), ["Obligation", "Price or figure", "Technology"]);
  assert.equal(rows[2]?.line, "Methanol dual-fuel engines is at technology readiness level 8. It reaches this item through Methanol.");
});

test("a cross-surface pattern leaves the Operations recalculated-figures rail; a price movement stays", () => {
  const row = (method_id: string) => ({ method_id, inputs: [{ table: "market_series", pk: "m" }] }) as never;
  assert.equal(isOperationsFigure(row("market_series_delta")), true);
  assert.equal(isOperationsFigure(row("pattern_lead_lag")), false);
});

test("INV-6: the radar's links and cards keep the 44 px target of law 2", () => {
  const css = readFileSync("src/ui/base.css", "utf8");
  assert.match(css, /\.cl-detail-link-tap \{[^}]*min-height: 44px/);
  assert.match(css, /\.cl-detail-link \{[^}]*min-height: 44px/);
  const html = renderApp(createElement(FlywheelRadar, { view: { patterns: [{ key: "k", label: "L", means: "M", forming: false, groups: [{ surface: "regulations", label: "Regulations", href: "/regulations", items: [{ title: "A", href: "/regulations/a" }], names: [] }], watch: null, missingParts: [], next: null }], forming: [] } }));
  assert.match(html, /class="cl-detail-link-tap"/);
});
