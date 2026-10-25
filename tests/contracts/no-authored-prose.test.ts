// ADR-050, standing rule 2: only a reader (the drain) authors sentences. Code extracts verbatim spans, classifies them into tokens from data files and writes structured fields.
// Every string a derive path emits must be (a) an id or date present in its input, (b) a token present in the path's data file, or (c) a substring of a verbatim span in its input.
import assert from "node:assert/strict";
import { test } from "node:test";

import { entityId } from "@/core/entities/id";
import horizonsJson from "@/core/themes/data/horizons.json";
import { themeAnalysisView, type MemberRow, type ThemeEventRow, type ThemeRow } from "@/core/themes";
import { SURFACE_ORDER } from "@/core/routing";
import { ABSENCE_TOKEN } from "@/core/brief";
import { DUTY_HOLDER_CLASSES, VOCABULARIES } from "@/core/contracts/vocabularies";
import unitFile from "@/core/parse/data/statutory-units.json" with { type: "json" };
import stubBrief from "@/features/intake/record-facts/data/stub-brief.json";
import { buildRecordPayload } from "@/features/intake/record-facts/payload";
import objectRules from "@/features/obligations/derive/data/object-rules.json";
import { deriveObligationObjects } from "@/features/obligations";
import { fillObjectFields } from "@/features/obligations/derive/fill-fields";
import assessmentCopy from "@/features/research/model/data/assessment-copy.json";
import stanceRules from "@/features/research/model/data/assessment-stance.json";
import { selectAssessmentView, selectSignpostView, type AssessmentRow } from "@/features/research/model/assessment-view";

import { connectDb } from "../connect/world.ts";

interface Allowed {
  /** Ids, dates and event kinds present in the input. */
  inputs: ReadonlySet<string>;
  /** Tokens present in the path's data files. */
  tokens: ReadonlySet<string>;
  /** Verbatim spans of the input; any string that is a substring of one is the span's own text. */
  spans: readonly string[];
}

/** Every string leaf of a value; a string that is itself JSON (a structured field stored as text) is walked as JSON. */
function leaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    let parsed: unknown;
    try {
      parsed = /^\s*[[{]/.test(v) ? JSON.parse(v) : undefined;
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) return leaves(parsed, out);
    out.push(v);
  } else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, out));
  return out;
}
const offenders = (output: unknown, a: Allowed): string[] => leaves(output).filter((s) => !(a.inputs.has(s) || a.tokens.has(s) || a.spans.some((sp) => sp.includes(s))));

test("the walker names a planted template sentence", () => {
  const a: Allowed = { inputs: new Set(["reg"]), tokens: new Set(["0-12m"]), spans: ["Article 6(1) Manufacturers shall ensure x."] };
  assert.deepEqual(offenders({ ids: ["reg"], horizon: "0-12m", span: "Manufacturers shall ensure x." }, a), []);
  assert.deepEqual(offenders({ guidance: "Immediate action required for near-term mandates." }, a), ["Immediate action required for near-term mandates."]);
});

test("the theme forward outlook carries only input ids and dates, horizon tokens and surface keys", () => {
  const theme: ThemeRow = { id: "t1", member_ids: ["reg", "ops"], surfaces: ["regulations", "operations"], pivots: [{ id: "reg" }] };
  const members: MemberRow[] = [
    { id: "reg", legacy_id: "reg", title: "Packaging Mandate", item_type: "regulation", domain: 1 },
    { id: "ops", legacy_id: "ops", title: "Warehouse Sorting Run", item_type: "regional_data", domain: 3 },
  ];
  const events: ThemeEventRow[] = [{ id: "ev-1", intelligence_item_id: "reg", event_date: "2027-01-01", date_precision: "day", event_kind: "compliance_deadline" }];
  const view = themeAnalysisView({ itemId: "reg", surface: "regulations", themes: [theme], briefs: [], members, events, asOfIso: "2026-10-24T00:00:00Z" });
  assert.ok(view);
  const a: Allowed = {
    inputs: new Set(["reg", "ops", "ev-1", "2027-01-01", "day", "compliance_deadline"]),
    tokens: new Set([...horizonsJson.bands.map((b) => b.code), ...horizonsJson.windows.map((w) => w.token), horizonsJson.unplaced, ...SURFACE_ORDER]),
    spans: [],
  };
  assert.deepEqual(offenders(view.forwardOutlook, a), []);
});

test("the assessment outlook is two tokens from the rules file", () => {
  const row = { id: "a1", item_id: "i1", horizon_band: "NEAR", horizon_kind: "obligation", refusal_reason: null, computed_at: "2026-10-21T00:00:00Z" } as AssessmentRow;
  const outlook = selectAssessmentView(row)?.forwardOutlook;
  assert.ok(outlook);
  const a: Allowed = { inputs: new Set(), tokens: new Set([...stanceRules.stances, ...stanceRules.horizons]), spans: [] };
  assert.deepEqual(offenders(outlook, a), []);
});

test("the obligation-object derive path writes spans, ids, dates and data-file tokens, and no sentence of its own", async () => {
  const item = { id: "i-ppwr", title: "Packaging and Packaging Waste Regulation", provenance_status: "verified", replaced_by: null, is_archived: false, jurisdiction_iso: ["EU"], instrument_identifier: "Regulation (EU) 2025/400", canonical_instrument_key: null };
  const text = [
    "Article 6(1) Manufacturers shall ensure packaging contains at least 35% post-consumer recycled plastic content by weight.",
    "Article 33(1) Manufacturers shall draw up an EU declaration of conformity in accordance with Annex VIII and affix the CE marking.",
    "Article 10(2) Economic operators shall ensure packaging meets the de minimis rule.",
    "Article 39(1) Producers shall register in the register of producers established by the competent authority.",
    "Article 40(1) Shipping companies shall pay fines of up to EUR 2 000 per tonne of carbon dioxide, calculated as the excess multiplied by the price.",
  ];
  const claims = text.map((t, i) => ({ id: `claim-${i}`, claim_kind: "FACT", source_span: t, search_result_id: "c-1", intelligence_item_id: "i-ppwr" }));
  const events = [{ id: "ev-1", intelligence_item_id: "i-ppwr", event_date: "2027-01-01", date_precision: "day", event_kind: "compliance_deadline", obligation_text: "Operators shall comply by 1 January 2027.", confidence: "high" }];
  const db = connectDb({
    intelligence_items: [item],
    agent_run_searches: [{ id: "c-1", intelligence_item_id: "i-ppwr", result_content: text.join("\n"), result_url: "https://eur-lex.europa.eu/ppwr", result_index: 0 }],
    section_claim_provenance: claims,
    item_forward_events: events,
    obligation_objects: [],
  }).db;
  const result = await deriveObligationObjects(db, { dry: true, itemIds: ["i-ppwr"] });
  const rows = (result.data as { plan: { toInsert: Array<{ row: Record<string, unknown> }> } }).plan.toInsert.map((x) => x.row);
  assert.equal(rows.length, 5);
  const classifiers = objectRules.triggerClassifiers;
  const a: Allowed = {
    inputs: new Set(["i-ppwr", "c-1", "2027-01-01", ...rows.map((r) => entityId("obligation", `i-ppwr|${String(r.pinpoint_citation).toLowerCase()}|v1`))]),
    tokens: new Set([
      ...classifiers.flatMap((c) => [c.attribute, "comparison" in c ? c.comparison : null, "token" in c ? c.token : null]).filter((t): t is string => typeof t === "string"),
      ...objectRules.artifactClasses.map((c) => c.class),
      objectRules.absence,
      objectRules.triggerAttribute,
      ...Object.keys(VOCABULARIES.binding_position ?? {}),
      ...Object.keys(DUTY_HOLDER_CLASSES),
      ...Object.keys(VOCABULARIES.transport_mode ?? {}),
      "not_assessed",
    ]),
    spans: [text.join("\n"), item.instrument_identifier],
  };
  assert.deepEqual(offenders(rows, a), []);
  assert.ok(rows.every((r) => r.plain_language === null), "plain_language is the reader's, never composed by code");
  // INV-DRV-3: mode, statutory_maximum and cost_formula are vocabulary tokens or the span's own words; the backfill's plan row adds only rule ids, the rules' own `on` values, unit tokens and the absence token.
  const shipping = rows.find((r) => String(r.pinpoint_citation) === "Article 40(1)");
  assert.deepEqual([shipping?.mode, shipping?.statutory_maximum, shipping?.cost_formula], [["ocean"], "fines of up to EUR 2 000 per tonne of carbon dioxide", "fines of up to EUR 2 000 per tonne of carbon dioxide, calculated as the excess multiplied by the price"]);
  const objectRow = (n: number, verbatim_text: string) => ({ obligation_id: `cl:obligation:${String(n).padStart(16, "0")}`, instrument_item_id: "i-ppwr", verbatim_text, mode: null, statutory_maximum: null, cost_formula: null });
  const filled = await fillObjectFields(connectDb({ intelligence_items: [{ ...item, title: "A plain notice" }], obligation_objects: [4, 0, 3].map((i, n) => objectRow(n + 1, text[i] as string)) }).db, { dry: true, after: null });
  const planRows = (filled.data as { plan: Array<{ obligation_id: string; modeAbsence: string | null }> }).plan;
  const planAllowed: Allowed = { inputs: new Set(["i-ppwr", ...planRows.map((r) => r.obligation_id)]), tokens: new Set([...a.tokens, ...objectRules.modeClassifiers.flatMap((c) => [c.id, c.on]), ...unitFile.forms.map((f) => f.unit)]), spans: [text.join("\n")] };
  assert.equal(planRows[2]?.modeAbsence, objectRules.absence, "a span no rule reads carries the stated absence token on its plan row");
  assert.deepEqual(offenders(planRows, planAllowed), []);
  assert.deepEqual(offenders({ statutory_maximum: "a fine of two thousand euros", mode: ["ocean"] }, planAllowed), ["a fine of two thousand euros"], "a planted template sentence is named");
});

test("INV-CTX6-1 the cluster summary carries ids, surface keys and signal tokens, never a sentence", () => {
  const theme: ThemeRow = { id: "t1", member_ids: ["reg", "ops", "mkt"], surfaces: ["regulations", "operations"], pivots: [{ id: "reg" }], dominant_signals: [{ signal: "shared_source", weight: 2 }], density: 0.82 };
  const members: MemberRow[] = [
    { id: "reg", legacy_id: "reg", title: "Packaging Mandate", item_type: "regulation", domain: 1 },
    { id: "ops", legacy_id: "ops", title: "Warehouse Sorting Run", item_type: "regional_data", domain: 3 },
  ];
  const view = themeAnalysisView({ itemId: "reg", surface: "regulations", themes: [theme], briefs: [], members, asOfIso: "2026-10-24T00:00:00Z" });
  assert.ok(view);
  const a: Allowed = { inputs: new Set(["reg", "ops", "mkt"]), tokens: new Set([...SURFACE_ORDER, "shared_source"]), spans: [] };
  assert.deepEqual(offenders(view.cluster, a), []);
});

test("INV-CTX6-1 the signpost predicate is a kind token and its own parameters, never a sentence", () => {
  const base = { entity_id: "cl:signpost:aa", assessment_id: "a1", watches: "cl:instrument:bb", direction: "confirms", fired_at: null };
  const predicates = [{ op: "date_passed", by: "2027-01-01", basis: "movement_by_date" }, { op: "date_passed" }, { op: "threshold", metric: "capacity_mw", gte: 40 }, { op: "threshold" }, { op: "count_gte", relation: "pilots", n: 3 }, { op: "count_gte" }, { op: "teleport" }, null];
  const a: Allowed = { inputs: new Set(["2027-01-01", "capacity_mw", "pilots"]), tokens: new Set(Object.keys(assessmentCopy.predicate)), spans: [] };
  for (const predicate of predicates) assert.deepEqual(offenders(selectSignpostView({ ...base, predicate } as never, () => null).predicate, a), [], JSON.stringify(predicate));
});

/** The strings a stored mint is made of: each line of a text field with its list, heading and emphasis marks removed, a `[slot_key]` prefix split off as its own id. */
const mintStrings = (v: unknown): string[] =>
  leaves(v).flatMap((s) => s.split("\n")).map((l) => l.trim().replace(/^(?:-\s+|##\s+)/, "").replace(/^\*(.*)\*$/, "$1").replace(/^Source:\s+/, "")).filter(Boolean).flatMap((l) => {
    const m = /^\[([a-z0-9_]+)\]\s*(.*)$/.exec(l);
    return m ? [m[1] ?? "", m[2] ?? ""].filter(Boolean) : [l];
  });

test("INV-MINT-1 the record mint stores ids, the absence token, its headings and verbatim spans, never a sentence of its own", () => {
  const captured = "A short note about nothing in particular, written for this fixture.";
  const url = "https://example.test/doc";
  const slots = ["effective_date", "penalty_summary", "jurisdictional_scope"];
  const p = buildRecordPayload({ sourceUrl: url, itemType: "regulation", title: "Zorblax Framework Instrument", source: { id: "s1" }, capturedText: captured, requiredSlots: slots });
  assert.ok(p.claims.length >= slots.length && p.claims.every((c) => c.claim_kind === "GAP"), "the fixture matches no trigger, so every claim is a stated absence");
  const a: Allowed = {
    inputs: new Set([url, "identity", "record_facts", "sources_and_citations", "GAP", ...p.claims.map((c) => c.slot_key)]),
    tokens: new Set([ABSENCE_TOKEN, stubBrief.marker, stubBrief.factsHeading, stubBrief.gapsHeading]),
    spans: [captured],
  };
  assert.deepEqual(offenders(mintStrings({ sections: p.sections, claims: p.claims, full_brief: p.item.full_brief }), a), []);
  assert.deepEqual(offenders(mintStrings("[effective_date] No verbatim effective date statement was located in the captured source text for this record-grade item."), a), ["No verbatim effective date statement was located in the captured source text for this record-grade item."]);
});
