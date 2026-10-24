// ADR-050, standing rule 2: only a reader (the drain) authors sentences. Code extracts verbatim spans, classifies them into tokens from data files and writes structured fields.
// Every string a derive path emits must be (a) an id or date present in its input, (b) a token present in the path's data file, or (c) a substring of a verbatim span in its input.
import assert from "node:assert/strict";
import { test } from "node:test";

import { entityId } from "@/core/entities/id";
import horizonsJson from "@/core/themes/data/horizons.json";
import { themeAnalysisView, type MemberRow, type ThemeEventRow, type ThemeRow } from "@/core/themes";
import { SURFACE_ORDER } from "@/core/routing";
import { DUTY_HOLDER_CLASSES, VOCABULARIES } from "@/core/contracts/vocabularies";
import objectRules from "@/features/obligations/derive/data/object-rules.json";
import { deriveObligationObjects } from "@/features/obligations";
import stanceRules from "@/features/research/model/data/assessment-stance.json";
import { selectAssessmentView, type AssessmentRow } from "@/features/research/model/assessment-view";

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
  assert.equal(rows.length, 4);
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
      "not_assessed",
    ]),
    spans: [text.join("\n"), item.instrument_identifier],
  };
  assert.deepEqual(offenders(rows, a), []);
  assert.ok(rows.every((r) => r.plain_language === null), "plain_language is the reader's, never composed by code");
});
