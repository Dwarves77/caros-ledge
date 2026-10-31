// The pure parts of the detail architecture, the jurisdiction model, the applicability gate, the theme views and the map's roll-up: each invariant is asserted on a value that would differ if the rule were broken.
import assert from "node:assert/strict";
import { test } from "node:test";

import { computeApplicability } from "@/core/applicability";
import { deriveFactCardModels, deriveRecordFactCardModel, mergeAdjacentSameKind, parseFactParagraphs } from "@/core/detail/fact-model";
import { crossPageOrd, indexFor, SECTION_INDEX } from "@/core/detail/section-index";
import { formatTrajectoryStep, pickCurrentStepIndex, withObligationEvents } from "@/core/detail/timeline";
import { countryGroupForIso, countryOf, isIso, isoCodesOf, isoToDisplayLabel, jurisdictionTier, jurisLabelOf, TIER1, TIER1_REGIONS, TIER2 } from "@/core/jurisdictions";
import { themeAnalysisView, themeChips, themeForItem } from "@/core/themes";
import { classifyMilestones, collapseTimeline } from "@/ui/timeline-math";
import { coverageLineModel } from "@/features/regulations/coverage-line";
import { isIdLabel } from "@/ui/detail/collab/collab-client";
import { centroidOf } from "@/features/regulations/map/centroids";
import { markerSize } from "@/features/regulations/map/marker";
import { regionCodes } from "@/features/regulations/map/region-filter";
import { chipOfKey, jurisdictionKeyOf, rollup } from "@/features/regulations/map/rollup";
import { joinSegments } from "@/features/regulations/meta";

const parseFactCardModels = (markdown: string): ReturnType<typeof deriveFactCardModels> => mergeAdjacentSameKind(parseFactParagraphs(markdown).flatMap(deriveFactCardModels));

const EU27 = "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" ");

test("iso labels: every EU member has a name (the old table printed 14 as raw codes), and the answer never depends on Intl (server and browser read the same table)", () => {
  for (const c of EU27) assert.notEqual(isoToDisplayLabel(c), c, `${c} has a label`);
  const real = Intl.DisplayNames;
  const before = EU27.map(isoToDisplayLabel);
  // A deliberately hostile runtime: a different ICU would answer differently, the table does not.
  (Intl as unknown as { DisplayNames: unknown }).DisplayNames = class {
    of() {
      return "different";
    }
  };
  try {
    assert.deepEqual(EU27.map(isoToDisplayLabel), before);
  } finally {
    (Intl as unknown as { DisplayNames: unknown }).DisplayNames = real;
  }
  assert.equal(isoToDisplayLabel("US-CA"), "California, United States");
  assert.equal(isoToDisplayLabel("EU"), "European Union");
  assert.equal(isoToDisplayLabel("ZZ"), "ZZ", "an unknown code is itself, never a guess");
  assert.ok(isIso("GB-ENG") && isIso("GLOBAL") && !isIso("gb") && !isIso("USA"));
  assert.equal(countryOf("US-CA"), "US");
  assert.equal(countryOf("EU"), null);
  assert.deepEqual([countryGroupForIso("US-CA"), countryGroupForIso("DE"), countryGroupForIso("EU")], ["US", "DE", "EU"], "the country of a code, or the code itself");
});

test("ONE Tier-1 list: the priority regions and the country-level scopes are one set, Tier 2 never repeats Tier 1, and the old tier tables keep their codes", () => {
  for (const r of TIER1_REGIONS) for (const j of r.jurisdictions) assert.equal(jurisdictionTier(j.iso), 1, `${j.iso} is Tier 1`);
  for (const c of ["US", "EU", "GB", "CA", "AE", "SA", "BR", "MX", "ZA", "KE", "NG"]) assert.equal(jurisdictionTier(c), 1, `${c}`);
  assert.equal(jurisdictionTier("CH"), 2);
  assert.equal(jurisdictionTier("CN-44"), 2);
  assert.equal(jurisdictionTier("LK"), 3);
  assert.equal(jurisdictionTier("not a code"), null);
  assert.deepEqual(TIER2.filter((c) => TIER1.includes(c)), []);
  assert.equal(new Set(TIER1).size, TIER1.length);
});

test("legacy slugs map to a code only where a row has no jurisdiction_iso; a grouping has none", () => {
  assert.deepEqual(isoCodesOf({ jurisdiction: "uk" }), ["GB"]);
  assert.deepEqual(isoCodesOf({ jurisdictionIso: ["DE"], jurisdiction: "france" }), ["DE"], "the code wins");
  assert.deepEqual(isoCodesOf({ jurisdiction: "france" }), ["FR"]);
  assert.deepEqual(isoCodesOf({ jurisdiction: "nordic" }), []);
  assert.equal(jurisLabelOf({ jurisdictionIso: ["DE", "FR"] }), "Germany · France");
  assert.equal(jurisLabelOf({ jurisdiction: "uk" }), "United Kingdom");
  assert.equal(jurisLabelOf({}), "", "a row that names no jurisdiction is not labelled with one (it was \"Global\")");
});

test("computeApplicability: no scope applies; an unset role or size is needs-input, never assumed; a role mismatch and a size below the threshold do not apply", () => {
  assert.equal(computeApplicability({}, {}).status, "applies");
  assert.equal(computeApplicability({ roleScope: ["forwarder"] }, { orgRoles: [] }).status, "needs_profile_input");
  assert.deepEqual(computeApplicability({ roleScope: ["forwarder"] }, { orgRoles: [] }).missingDimensions, ["role"]);
  assert.equal(computeApplicability({ roleScope: ["forwarder"] }, { orgRoles: ["carrier"] }).status, "does_not_apply");
  assert.equal(computeApplicability({ roleScope: ["forwarder"] }, { orgRoles: ["forwarder", "carrier"] }).status, "applies");
  const nobody = { headcount_band: null, revenue_band: null, shipment_volume_band: null };
  const big = { sizeThreshold: { dimension: "headcount", band: "large", comparison: "at_least" as const } };
  assert.equal(computeApplicability(big, { orgRoles: [], orgSize: nobody }).status, "needs_profile_input", "an unset size is never assumed");
  assert.deepEqual(computeApplicability(big, { orgRoles: [], orgSize: nobody }).missingDimensions, ["headcount"]);
  assert.equal(computeApplicability(big, { orgRoles: [], orgSize: { ...nobody, headcount_band: "small" } }).status, "does_not_apply");
  assert.equal(computeApplicability(big, { orgRoles: [], orgSize: { ...nobody, headcount_band: "large" } }).status, "applies");
  assert.equal(computeApplicability({ sizeThreshold: { dimension: "headcount", band: "small", comparison: "below" } }, { orgRoles: [], orgSize: { ...nobody, headcount_band: "micro" } }).status, "applies");
  assert.equal(computeApplicability({ sizeThreshold: { dimension: "nonsense", band: "x" } }, {}).status, "applies", "an unknown dimension cannot gate");
});

test("section index: ordinals are fixed (a missing section is omitted, never renumbered), the unrendered fact-document sections gain entries, and the page's ten keep theirs", () => {
  const ords = Object.fromEntries(SECTION_INDEX.map((e) => [e.id, e.ord]));
  assert.deepEqual([ords.summary, ords.obligations, ords.requirements, ords.registration, ords.operations, ords.compliance, ords.penalties, ords.sources, ords["across-pages"], ords.inferences], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(new Set(SECTION_INDEX.map((e) => e.ord)).size, SECTION_INDEX.length, "no ordinal twice");
  const keys = SECTION_INDEX.flatMap((e) => (e.key ? [e.key] : [])).sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(keys, ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"], "every stored fact-document section but 14 and 15 has an entry");
  assert.deepEqual(indexFor(new Set(["summary", "sources", "compliance"])).map((e) => [e.id, e.ord]), [["summary", 1], ["compliance", 6], ["sources", 8]]);
  assert.equal(crossPageOrd("regulations", "inferences"), 10);
  assert.equal(crossPageOrd("market", "inferences"), 8);
});

test("timeline and trajectory take the request's instant: the same input at two instants differs, and no Date is built for display", () => {
  const steps = [{ date: "2026", value: "2%" }, { date: "2030-01-01", value: "6%" }, { date: "2035-01-01", value: "20%" }];
  assert.equal(pickCurrentStepIndex(steps, "2026-10-15T00:00:00Z"), 1);
  assert.equal(pickCurrentStepIndex(steps, "2031-01-01T00:00:00Z"), 2);
  assert.equal(pickCurrentStepIndex(steps, "2040-01-01T00:00:00Z"), 2, "past the last step the last applies");
  assert.equal(pickCurrentStepIndex([{ date: "later", value: "x" }], "2026-10-15T00:00:00Z"), -1);
  assert.equal(formatTrajectoryStep(steps[1] as (typeof steps)[number]), "6% (Jan 1 2030)");
  assert.equal(formatTrajectoryStep(steps[0] as (typeof steps)[number]), "2% (2026)");
  const four = Array.from({ length: 4 }, (_, i) => ({ date: `2026-0${i + 1}-01`, label: `m${i}` }));
  const five = [...four, { date: "2026-09-01", label: "m4" }];
  assert.equal(collapseTimeline(classifyMilestones(four)).collapsed, false);
  const c5 = collapseTimeline(classifyMilestones(five));
  assert.deepEqual([c5.collapsed, c5.visible.length, c5.hiddenCount], [true, 4, 1]);
  assert.deepEqual(withObligationEvents([{ date: "2026-01-01", label: "a" }], [{ event_date: "2026-01-01", event_kind: "x" }, { event_date: "2026-02-01", event_kind: "entry_into_force" }], { entry_into_force: "Entry into force" }).map((t) => t.label), ["a", "Entry into force"], "an event on a date already on the timeline is not repeated");
});

test("fact model: kinds from lead-ins, embedded sentences split, a source citation becomes provenance, same-kind runs merge, prose is not a card", () => {
  const md = "**DEADLINE** Reports are due by **31 March 2027** each year. Source: EUR-Lex, Regulation 2023/9999, 2026 https://eur-lex.europa.eu/x\n\n**DEADLINE** A second deadline applies on 1 July. Source: EUR-Lex, 2026\n\nPlain prose with no source.\n\n*Operational implication:* a procurement lead asks each carrier.";
  const paragraphs = parseFactParagraphs(md);
  assert.deepEqual(paragraphs.map((p) => p.kind), ["fact", "fact", "prose", "inference"]);
  const models = parseFactCardModels(md);
  assert.deepEqual(models.map((m) => m.kind), ["DEADLINE", "ANALYTICAL INFERENCE"], "the two deadlines merged, the prose is not a card");
  assert.equal(models[0]?.additionalClaims?.length, 1);
  assert.equal(models[0]?.figureLead, "31 March 2027");
  assert.equal(models[0]?.provenance?.source, "EUR-Lex");
  assert.equal(models[1]?.claim[0]?.text, "A procurement lead asks each carrier.");
  assert.equal(deriveFactCardModels(paragraphs[2] as (typeof paragraphs)[number]).length, 0);
  assert.equal(mergeAdjacentSameKind([]).length, 0);
  assert.equal(deriveRecordFactCardModel({ label: "x", span: null }), null, "a record fact with no quoted span is not a card");
});

test("fact model: a figure lead is a figure, never a bold sentence or a name that happens to hold a digit (it is drawn in a 132 px display column)", () => {
  const lead = (md: string) => parseFactCardModels(`${md} Source: EUR-Lex, 2026`)[0]?.figureLead ?? null;
  const long = "Trend 1 — Packaging Design: Regions are formalizing definitions of recyclability.";
  assert.equal(lead(`**DEADLINE** **${long}** The report identifies that guidance on recyclability is increasingly defined by producer schemes.`), null, "a bold sentence is not a figure");
  assert.equal(lead("**DEADLINE** **California SB 343** EPR legislation is reclassifying what counts as recyclable."), null, "a bold name with a number in it is not a figure");
  assert.equal(lead("**DEADLINE** Recovery reaches **50-65%** of material in the sorting stream."), "50-65%");
  assert.equal(lead("**DEADLINE** Reports are due by **31 March 2027** each year."), "31 March 2027");
  assert.equal(lead("**DEADLINE** Fees start at **€2.5 per tonne** from 2027."), "€2.5 per tonne");
});

test("fact model: a paragraph that quotes several people, each with a Source line, cites the last one; the provenance never carries the whole paragraph", () => {
  const md = "**SCOPE** One quote - **Tom Hendrickson**, Industry Affairs Manager, IMFA. *Source: Packaging World, May 6, 2026. https://www.packworld.com/a* Another quote - **Rhodes Yepsen**, Executive Director, BPI, warns that misaligned laws risk eliminating compostables. *Source: Packaging World, May 6, 2026. https://www.packworld.com/b*";
  const [model] = parseFactCardModels(md);
  assert.equal(model?.provenance?.href, "https://www.packworld.com/b");
  assert.equal(model?.provenance?.source, "Packaging World");
  assert.ok((model?.provenance?.org ?? "").length < 40, `the issuer is ${(model?.provenance?.org ?? "").length} characters`);
  assert.ok(!(model?.claim ?? []).some((n) => n.text.includes("*")), "no raw asterisks reach the claim");
});

test("theme views: the item's theme, the chips of a surface, the analysis when no brief exists, the label when no brief names a theme", () => {
  const themes = [{ id: "t1", member_ids: ["a", "b"], dominant_signals: [{ signal: "shared_source", weight: 2 }], surfaces: ["regulations", "market"], convergence: 0.9, pivots: [] }, { id: "t2", member_ids: ["c"], surfaces: ["regulations"], convergence: 0.1 }];
  assert.equal(themeForItem(themes as never, "b")?.id, "t1");
  assert.equal(themeForItem(themes as never, "zzz"), null);
  const items = [{ id: "a", legacy_id: "g1", title: "Reg A", item_type: "regulation", domain: 1 }, { id: "b", legacy_id: null, title: "Mkt B", item_type: "market_signal", domain: 4 }];
  const chips = themeChips({ themes: themes as never, items, surface: "regulations", max: 6 });
  assert.deepEqual(chips.map((c) => [c.themeId, c.href, c.hasBrief]), [["t1", "/regulations/g1", false]]);
  assert.match(chips[0]?.label ?? "", /^2 linked items across /);
  const view = themeAnalysisView({ itemId: "a", surface: "regulations", themes: themes as never, briefs: [], members: items, asOfIso: "2026-10-24T00:00:00Z" });
  assert.equal(view?.hasBrief, false);
  assert.deepEqual([view?.cluster?.memberCount, view?.cluster?.surfaces], [2, ["regulations", "market"]]);
  assert.deepEqual(view?.membersByPage.map((g) => [g.surface, g.total]), [["market", 1]]);
  const unsignalled = themeChips({ themes: [{ id: "t3", member_ids: ["a", "b"], surfaces: ["regulations", "market"], convergence: 0.5, pivots: [] }] as never, items, surface: "regulations", max: 6 });
  assert.ok((unsignalled[0]?.label ?? "").length > 0, "a theme with no named signal still has a label");
});

test("map: a row counts once under its primary code rolled up to the country; the title never decides the jurisdiction; subdivisions and EU members chip correctly", () => {
  const row = (id: string, over: object) => ({ id, title: "Carbon levy in Japan", priority: "HIGH", modes: [] as string[], ...over });
  assert.equal(jurisdictionKeyOf({ jurisdictionIso: ["US-CA"] }), "US");
  assert.equal(jurisdictionKeyOf({ jurisdictionIso: ["EU", "DE"] }), "EU");
  assert.equal(jurisdictionKeyOf({ jurisdiction: "nordic" }), "nordic");
  assert.equal(jurisdictionKeyOf({}), "global");
  const rows = rollup([row("1", { jurisdictionIso: ["JP"] }), row("2", { jurisdictionIso: ["US-CA"], priority: "CRITICAL" }), row("3", { jurisdictionIso: ["US-NY"], priority: "LOW" }), row("4", { jurisdiction: "nordic" })]);
  assert.deepEqual(rows.map((r) => [r.key, r.count, r.band.key]), [["US", 2, "immediate"], ["JP", 1, "action"], ["nordic", 1, "action"]]);
  assert.equal(rows.find((r) => r.key === "US")?.label, "United States");
  assert.deepEqual(rows.find((r) => r.key === "US")?.codes.sort(), ["US-CA", "US-NY"]);
  const eu = new Set(EU27);
  assert.equal(chipOfKey("DE", eu), "EU", "Germany is on the EU chip (the old chip held only the slug eu)");
  assert.equal(chipOfKey("US", eu), "US");
  assert.equal(chipOfKey("GB", eu), "UK");
  assert.equal(chipOfKey("BR", eu), "LATAM");
  assert.equal(chipOfKey("CA", eu), null);
  assert.equal(chipOfKey("KE", eu), "MEAF");
  assert.deepEqual(centroidOf("US"), [38, -97]);
  assert.equal(centroidOf("nordic")?.length, 2);
  assert.equal(centroidOf("ZZ"), null, "no centroid: not charted, still listed");
  assert.ok(markerSize(1) >= 22 && markerSize(10_000) <= 56 && markerSize(100) > markerSize(5));
});

test("the map's region filter resolves: a priority-region id, one priority code, else nothing (an unknown value filters nothing)", () => {
  assert.equal(regionCodes("us-subnational")?.length, 56);
  assert.deepEqual(regionCodes("eu"), ["EU"]);
  assert.equal(regionCodes("atlantis"), null);
  assert.equal(regionCodes(""), null);
});

test("the dek is built once and never repeats a part", () => {
  assert.equal(joinSegments(["Germany · Federal Ministry", "Federal Ministry", "Germany", "Effective 1 Jan 2027"]), "Germany · Federal Ministry · Effective 1 Jan 2027");
});

test("the coverage line always draws its link: a refused or failed count is the unavailable state, an empty catalogue its own, a count the count", () => {
  const line = { surface: "regulations", label: "Regulations", numerator: 3, denominator: 10, verifiedBriefs: 2, href: "/dashboard/coverage?class=regulations" };
  assert.deepEqual(coverageLineModel(line, false, "regulations"), { href: line.href, state: "count" });
  assert.deepEqual(coverageLineModel({ ...line, denominator: 0 }, false, "regulations"), { href: line.href, state: "empty-catalogue" });
  for (const [d, failed] of [[null, true], [null, false], [line, true]] as const) {
    const m = coverageLineModel(d, failed, "regulations");
    assert.equal(m.state, "unavailable");
    assert.ok(m.href.startsWith("/dashboard/coverage"), "the link is drawn whatever the count did");
  }
});

test("a roster label that is only the id prefix is recognised, a real name never is", () => {
  assert.equal(isIdLabel("6853b368..."), true);
  for (const name of ["Jason", "Pat Lee", "smoke@example.invalid", "abcdef12 Lee...", "6853b368", "6853b36x..."]) assert.equal(isIdLabel(name), false, name);
});
