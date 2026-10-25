// Ported from old_repo/scripts/obligations/derive-obligation-objects.mjs (lines 1-211)
// The obligation-object grain (migration 376, spec 01 section 3.2): one object per pinpoint, written ONLY from a candidate whose verbatim text is in its named
// capture of the SAME instrument item, with known duty-holder classes, a well-formed applicability trigger, status not_assessed, version = prior + 1 with
// supersedes set, idempotent. THE PRODUCER (the old writer had none: B-0574/0697/1610): candidates come from two deterministic, free producers that run
// inside connectDeps.deriveObligations and the corpus pass (rule 17): (1) FACT claims whose verbatim span names an Article pinpoint, a duty holder and a
// deontic verb; (2) the FuelEU Article 4(2) trajectory 2025-2050 as data (BUILD-PLAN ruling 8), each period only when its quote is verbatim in a held capture.
// The four-date timeline (entry into force, date of application, first deadline, enforcement start) is filled only from DAY-precision forward events of the
// same item: a date is never invented.
import { z } from "zod";

import { DUTY_HOLDER_CLASSES, isMissing, isValid, LEG_MODE_CODES, OBS_STATUS } from "@/core/contracts/vocabularies";
import { readFactSuppressionsFor } from "@/core/detail/claim-tiers";
import { admissibleClaims, admitItems } from "@/core/derived/admissible";
import { isVerbatim } from "@/core/contracts/verbatim";
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import { entityId } from "@/core/entities/id";
import type { RunResult } from "@/core/sources/run-result";
import { currentObligationObjects } from "@/core/workspace";

import { sentenceEnd, sentenceStart } from "../extract/window";

import { classifyItemBindingPosition, type ItemForClassification } from "./classify-binding-position";
import rulesJson from "./data/object-rules.json";
import targetsJson from "./data/fueleu-targets.json";

export const OBJECT_DERIVATION_VERSION = "oblig-objects-2026-10-20.1";
const FREQUENCIES: ReadonlySet<string> = new Set(["annual", "per_consignment", "per_voyage", "event_triggered"]);
const MODE_ALIASES: ReadonlySet<string> = new Set(["sea", "maritime", "water", "vessel", "marine", "truck", "lorry", "hgv", "barge", "iww", "inland-waterway", "freighter", "airfreight"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_COLUMNS = ["entry_into_force", "date_of_application", "first_deadline", "enforcement_start", "date_reviewed", "next_review_due"] as const;
const MONEY_KEYS = ["amount", "currency", "price", "cost"];

const re = z.string();
const rules = z.object({
  phrases: z.array(z.object({ class: z.string(), pattern: re })),
  pinpoint: re,
  deontic: re,
  crossReference: re,
  window: z.object({ maxSentence: z.number(), pinpointLookBack: z.number(), headingOverlap: z.number(), subjectDistance: z.number() }),
  triggerAttribute: z.string(),
  datePhrases: z.object({ date_of_application: re, enforcement_start: re }),
  triggerClassifiers: z.array(z.object({ attribute: z.string(), comparison: z.string().optional(), token: z.string().optional(), pattern: re })),
  artifactClasses: z.array(z.object({ class: z.string(), pattern: re })),
  absence: z.string(),
}).parse(rulesJson);
if (!OBS_STATUS[rules.absence] || OBS_STATUS[rules.absence]?.isPresent !== false) throw new Error(`object-rules.json absence "${rules.absence}" is not a missing code of the obs_status vocabulary`);
const TRIGGER_CLASSIFIERS = rules.triggerClassifiers.map((c) => ({ ...c, re: new RegExp(c.pattern, "i") }));
const ARTIFACT_CLASSES = rules.artifactClasses.map((c) => ({ class: c.class, re: new RegExp(c.pattern, "i") }));
const targets = z.object({
  instrument: z.object({ celex: z.string(), identityPattern: z.string(), pinpointBase: z.string(), dutyHolderClass: z.array(z.string()), applicabilityAttribute: z.string(), jurisdiction: z.array(z.string()), mode: z.array(z.string()) }),
  referenceValue: z.object({ value: z.number(), unit: z.string(), quote: z.string() }),
  periods: z.array(z.object({ from_date: z.string(), reduction_percent: z.number(), target_gco2e_per_mj: z.number(), quote: z.string() })),
  source: z.object({ url: z.string(), article: z.string(), verified_at: z.string() }),
}).parse(targetsJson);
const PHRASES = rules.phrases.map((p) => ({ class: p.class, re: new RegExp(p.pattern, "i") }));
const PINPOINT_RE = new RegExp(rules.pinpoint, "i");
const DEONTIC_RE = new RegExp(rules.deontic, "i");
const DEONTIC_ALL = new RegExp(rules.deontic, "ig");
const PINPOINT_ALL = new RegExp(rules.pinpoint, "ig");
const CROSS_REFERENCE_RE = new RegExp(rules.crossReference, "i");
const APPLICATION_RE = new RegExp(rules.datePhrases.date_of_application, "i");
const ENFORCEMENT_RE = new RegExp(rules.datePhrases.enforcement_start, "i");
const FUELEU_TARGETS = targets;

const nz = (s: unknown): string => (typeof s === "string" ? s.trim() : "");
const norm = (s: unknown): string => nz(s).toLowerCase();
const nullable = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

export interface Candidate {
  instrument_item_id: string; capture_id: string; pinpoint_citation: string; verbatim_text: string;
  plain_language?: string | null; binding_position?: string | null; duty_holder_class: string[];
  applicability_trigger: { attribute: string; value: string; comparison?: string; obs_status?: string };
  jurisdiction?: string[] | null; mode?: string[] | null; vertical?: string[] | null; frequency?: string | null;
  entry_into_force?: string | null; date_of_application?: string | null; first_deadline?: string | null; enforcement_start?: string | null;
  evidence_required?: string | null; evidence_artifacts?: Array<{ class: string; name: string }> | null; retention_period?: string | null; sanction_class?: string | null; severity_score?: number | null;
  statutory_maximum?: string | null; cost_formula?: string | null; direct_compliance_cost?: Record<string, unknown> | null;
  effort?: Record<string, unknown> | null; status?: string | null; date_reviewed?: string | null; next_review_due?: string | null; source_id?: string | null;
}
export interface CaptureRow { id: string; intelligence_item_id: string; result_content: string | null; }
export interface ExistingObject { obligation_id: string; instrument_item_id: string; pinpoint_citation: string; verbatim_text: string; version: number; supersedes?: string | null; }
export interface ObjectItem extends ItemForClassification { id: string; is_archived?: boolean | null; }

export type BuildResult = { ok: true; row: Record<string, unknown>; bindingSource: string } | { ok: false; reason: string };

/** One object row from a candidate, or the named refusal. The span must be in the capture of the same instrument item; nothing is guessed. */
function buildObjectRow(c: Candidate, ctx: { item: ObjectItem | null; capture: CaptureRow | null; existingForPinpoint: ExistingObject | null; classify?: typeof classifyItemBindingPosition }): BuildResult {
  const { item, capture, existingForPinpoint } = ctx;
  const classify = ctx.classify ?? classifyItemBindingPosition;
  if (!c || typeof c !== "object") return { ok: false, reason: "candidate_not_an_object" };
  if (!item) return { ok: false, reason: "instrument_item_missing" };
  if (item.is_archived) return { ok: false, reason: "instrument_item_archived" };
  if (!capture) return { ok: false, reason: "capture_missing" };
  if (capture.intelligence_item_id !== c.instrument_item_id) return { ok: false, reason: "capture_not_of_instrument" };
  if (!nz(c.pinpoint_citation)) return { ok: false, reason: "pinpoint_blank" };
  if (!isVerbatim(capture.result_content, nz(c.verbatim_text))) return { ok: false, reason: "span_not_verbatim" };
  if (c.status !== undefined && c.status !== null && c.status !== "not_assessed") return { ok: false, reason: "status_not_writer_owned" };
  const classes = Array.isArray(c.duty_holder_class) ? c.duty_holder_class.filter((x) => typeof x === "string" && x.trim()) : [];
  if (!classes.length) return { ok: false, reason: "duty_holder_missing" };
  const unknown = classes.find((x) => !DUTY_HOLDER_CLASSES[x]);
  if (unknown) return { ok: false, reason: `duty_holder_unknown:${unknown}` };
  const t = c.applicability_trigger;
  if (!(t && typeof t === "object" && !Array.isArray(t) && nz(t.attribute) && nz(t.value) && typeof t.attribute === "string" && typeof t.value === "string")) return { ok: false, reason: "trigger_malformed" };
  if (t.obs_status !== undefined && (!isMissing(t.obs_status) || t.value !== t.obs_status)) return { ok: false, reason: "trigger_obs_status_invalid" };
  if (c.frequency != null && !FREQUENCIES.has(c.frequency)) return { ok: false, reason: "frequency_invalid" };
  if (Array.isArray(c.mode) && c.mode.some((m) => MODE_ALIASES.has(m) || !LEG_MODE_CODES.includes(m))) return { ok: false, reason: "mode_alias" };
  for (const col of DATE_COLUMNS) if (c[col] != null && !(typeof c[col] === "string" && DATE_RE.test(c[col] as string))) return { ok: false, reason: `date_malformed:${col}` };
  if (c.effort != null && (typeof c.effort !== "object" || MONEY_KEYS.some((k) => k in (c.effort as object)))) return { ok: false, reason: "effort_carries_money" };
  let position: string | null = null;
  let bindingSource = "candidate";
  if (c.binding_position != null) {
    if (!isValid("binding_position", c.binding_position)) return { ok: false, reason: `binding_position_unknown:${c.binding_position}` };
    position = c.binding_position;
  } else {
    const classified = classify(item, { dutyHolderClasses: classes });
    if (classified) {
      position = classified.position;
      bindingSource = classified.source;
    }
  }
  if (!position) return { ok: false, reason: "binding_position_unresolved" };
  const version = existingForPinpoint ? Number(existingForPinpoint.version) + 1 : 1;
  const row = {
    obligation_id: entityId("obligation", `${c.instrument_item_id}|${norm(c.pinpoint_citation)}|v${version}`), instrument_item_id: c.instrument_item_id, version, supersedes: existingForPinpoint ? existingForPinpoint.obligation_id : null,
    pinpoint_citation: c.pinpoint_citation, verbatim_text: c.verbatim_text, plain_language: nullable(c.plain_language), binding_position: position, duty_holder_class: classes,
    applicability_trigger: { attribute: t.attribute, value: t.value, ...(t.comparison ? { comparison: t.comparison } : {}), ...(t.obs_status ? { obs_status: t.obs_status } : {}) },
    jurisdiction: nullable(c.jurisdiction), mode: nullable(c.mode), vertical: nullable(c.vertical), frequency: nullable(c.frequency),
    entry_into_force: nullable(c.entry_into_force), date_of_application: nullable(c.date_of_application), first_deadline: nullable(c.first_deadline), enforcement_start: nullable(c.enforcement_start),
    evidence_required: nullable(c.evidence_required), evidence_artifacts: nullable(c.evidence_artifacts), retention_period: nullable(c.retention_period), sanction_class: nullable(c.sanction_class), severity_score: nullable(c.severity_score), statutory_maximum: nullable(c.statutory_maximum),
    cost_formula: nullable(c.cost_formula), direct_compliance_cost: nullable(c.direct_compliance_cost), effort: nullable(c.effort), status: "not_assessed",
    date_reviewed: nullable(c.date_reviewed), next_review_due: nullable(c.next_review_due), source_id: nullable(c.source_id), capture_id: c.capture_id,
  };
  return { ok: true, row, bindingSource };
}

export interface ObjectPlan {
  toInsert: { row: Record<string, unknown>; bindingSource: string }[];
  refused: { instrument_item_id: string | null; pinpoint_citation: string | null; reason: string }[];
  alreadyRegistered: number;
}
/** Plan a candidate batch against what is already registered: a repeat of the same text is a no-op, a changed text versions the pinpoint. */
function planObligationObjects(candidates: readonly Candidate[], ctx: { itemsById: ReadonlyMap<string, ObjectItem>; capturesById: ReadonlyMap<string, CaptureRow>; existing: readonly ExistingObject[]; classify?: typeof classifyItemBindingPosition }): ObjectPlan {
  const current = currentObligationObjects<ExistingObject>(ctx.existing);
  const byPinpoint = new Map(current.map((o) => [`${o.instrument_item_id}|${norm(o.pinpoint_citation)}`, o]));
  const existingIds = new Set(ctx.existing.map((o) => o.obligation_id));
  const plan: ObjectPlan = { toInsert: [], refused: [], alreadyRegistered: 0 };
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c?.instrument_item_id}|${norm(c?.pinpoint_citation)}`;
    const label = { instrument_item_id: c?.instrument_item_id ?? null, pinpoint_citation: c?.pinpoint_citation ?? null };
    if (seen.has(key)) {
      plan.refused.push({ ...label, reason: "duplicate_in_batch" });
      continue;
    }
    seen.add(key);
    const prior = byPinpoint.get(key) ?? null;
    if (prior && norm(prior.verbatim_text) === norm(c?.verbatim_text)) {
      plan.alreadyRegistered += 1;
      continue;
    }
    const built = buildObjectRow(c, { item: ctx.itemsById.get(c?.instrument_item_id) ?? null, capture: ctx.capturesById.get(c?.capture_id) ?? null, existingForPinpoint: prior, ...(ctx.classify ? { classify: ctx.classify } : {}) });
    if (!built.ok) plan.refused.push({ ...label, reason: built.reason });
    else if (existingIds.has(built.row.obligation_id as string)) plan.alreadyRegistered += 1;
    else plan.toInsert.push({ row: built.row, bindingSource: built.bindingSource });
  }
  return plan;
}

// -- producers ---------------------------------------------------------------------------------------------------------------------------------------

export interface EventForDates {
  event_date: string;
  date_precision: string;
  event_kind: string;
  obligation_text: string;
  confidence?: string | null;
}
/** The four-date timeline from DAY-precision events only (earliest of each family); a date that is not stated is null. */
function timelineFromEvents(events: readonly EventForDates[]): { entry_into_force: string | null; date_of_application: string | null; first_deadline: string | null; enforcement_start: string | null } {
  const days = events.filter((e) => e.date_precision === "day" && /^\d{4}-\d{2}-\d{2}$/.test(e.event_date)).sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : 0));
  const first = (pred: (e: EventForDates) => boolean): string | null => days.find(pred)?.event_date ?? null;
  return {
    entry_into_force: first((e) => e.event_kind === "entry_into_force" && !APPLICATION_RE.test(e.obligation_text) && !ENFORCEMENT_RE.test(e.obligation_text)) ?? null,
    date_of_application: first((e) => (e.event_kind === "phase_step" || e.event_kind === "entry_into_force") && APPLICATION_RE.test(e.obligation_text)),
    first_deadline: first((e) => e.event_kind === "compliance_deadline"),
    enforcement_start: first((e) => ENFORCEMENT_RE.test(e.obligation_text) && e.event_kind !== "consultation_close"),
  };
}

export interface ClaimForObjects {
  id: string;
  claim_text: string;
  claim_kind: string;
  source_span: string | null;
  search_result_id: string | null;
  source_id: string | null;
  intelligence_item_id: string;
}
const instrumentValue = (item: ObjectItem): string => nz(item.canonical_instrument_key) || nz(item.instrument_identifier) || nz(item.title);

/** The first classifier whose pattern is in the span, as a trigger: the value is the span's own text (the first capture group) or the classifier's token; a threshold whose value the span does not state is the stated absence, never a typed number. */
function classifyTrigger(span: string, fallbackValue: string): Candidate["applicability_trigger"] {
  for (const c of TRIGGER_CLASSIFIERS) {
    const m = c.re.exec(span);
    if (!m) continue;
    const comparison = c.comparison ? { comparison: c.comparison } : {};
    if (c.token) return { attribute: c.attribute, value: c.token, ...comparison };
    const stated = m.slice(1).find((g) => g !== undefined)?.trim();
    return stated ? { attribute: c.attribute, value: stated, ...comparison } : { attribute: c.attribute, value: rules.absence, obs_status: rules.absence, ...comparison };
  }
  return { attribute: rules.triggerAttribute, value: fallbackValue };
}

/** The compliance artifacts the span names: the class from the data file and the name exactly as the span writes it. Stored in evidence_artifacts (jsonb, 0126); null when the span names none. */
function extractArtifacts(span: string): Array<{ class: string; name: string }> | null {
  const found = ARTIFACT_CLASSES.flatMap((c) => { const name = c.re.exec(span)?.[0]; return name ? [{ class: c.class, name }] : []; });
  return found.length ? found : null;
}

/** One candidate from a span that names an Article pinpoint, a duty-holder phrase and a deontic verb, in the capture that holds it; null when it names none. Code never writes a sentence: plain_language is the reader's. */
function dutyCandidate(item: ObjectItem, span: string, captureId: string, sourceId: string | null, timeline: ReturnType<typeof timelineFromEvents>): Candidate | null {
  const value = instrumentValue(item);
  const pin = PINPOINT_RE.exec(span)?.[0];
  const holders = [...new Set(PHRASES.filter((p) => p.re.test(span)).map((p) => p.class))];
  if (!value || !pin || !holders.length || !DEONTIC_RE.test(span)) return null;
  return { instrument_item_id: item.id, capture_id: captureId, pinpoint_citation: pin.replace(/\s+/g, " "), verbatim_text: span, duty_holder_class: holders, applicability_trigger: classifyTrigger(span, value), evidence_artifacts: extractArtifacts(span), plain_language: null, ...timeline, source_id: sourceId };
}

/** FACT claims whose verbatim span names an Article pinpoint, a duty-holder phrase and a deontic verb: one candidate each, in its own capture. */
function candidatesFromClaims(item: ObjectItem, claims: readonly ClaimForObjects[], events: readonly EventForDates[]): Candidate[] {
  const timeline = timelineFromEvents(events);
  return claims.flatMap((c) => (c.claim_kind === "FACT" && c.source_span && c.search_result_id ? [dutyCandidate(item, c.source_span, c.search_result_id, c.source_id, timeline)] : [])).filter((c): c is Candidate => c !== null);
}

/**
 * The duty windows of a capture: each sentence whose deontic verb follows a duty-holder phrase (the holder is the subject: "operators shall", not "applicable in all Member States"), opened at the Article heading just before it (an Article named INSIDE the sentence, or one that cites another
 * instrument, is a cross-reference and names no pinpoint). A window is a contiguous slice of the capture, so it is verbatim in it by construction.
 */
function dutyWindows(text: string): string[] {
  const out: string[] = [];
  let closedAt = -1;
  for (const m of text.matchAll(DEONTIC_ALL)) {
    if (m.index < closedAt) continue;
    const start = sentenceStart(text, m.index, rules.window.maxSentence);
    const end = sentenceEnd(text, m.index, rules.window.maxSentence);
    if (end === null) continue;
    closedAt = end;
    if (!PHRASES.some((p) => p.re.test(text.slice(Math.max(start, m.index - rules.window.subjectDistance), m.index)))) continue;
    const lo = Math.max(0, start - rules.window.pinpointLookBack);
    const headings = [...text.slice(lo, start + rules.window.headingOverlap).matchAll(PINPOINT_ALL)].filter((p) => !CROSS_REFERENCE_RE.test(text.slice(lo + p.index + p[0].length, lo + p.index + p[0].length + 80)));
    const heading = headings.pop();
    if (heading) out.push(text.slice(lo + heading.index, end).trim());
  }
  return out;
}

/** One candidate per pinpoint from the item's captures: the primary text names its duties whether or not a brief claim quoted them. */
function candidatesFromCaptures(item: ObjectItem, captures: readonly CaptureRow[], events: readonly EventForDates[], withdrawn: readonly string[]): Candidate[] {
  const timeline = timelineFromEvents(events);
  const out = new Map<string, Candidate>();
  for (const cap of captures) {
    for (const window of dutyWindows(cap.result_content ?? "").filter((w) => !withdrawn.some((t) => isVerbatim(w, t)))) {
      const c = dutyCandidate(item, window, cap.id, null, timeline);
      if (c && !out.has(norm(c.pinpoint_citation))) out.set(norm(c.pinpoint_citation), c);
    }
  }
  return [...out.values()];
}

/** The FuelEU Article 4(2) trajectory: one candidate per period whose quote is verbatim in a held capture of the instrument; periods whose quote is nowhere held are not produced. */
function candidatesFromFueleuTargets(item: ObjectItem, captures: readonly CaptureRow[], events: readonly EventForDates[]): Candidate[] {
  const t = FUELEU_TARGETS.instrument;
  const identity = new RegExp(t.identityPattern, "i");
  if (!identity.test(`${item.canonical_instrument_key ?? ""} ${item.instrument_identifier ?? ""}`)) return [];
  const timeline = timelineFromEvents(events);
  const out: Candidate[] = [];
  for (const p of FUELEU_TARGETS.periods) {
    const capture = captures.find((c) => isVerbatim(c.result_content, p.quote));
    if (!capture) continue;
    out.push({
      instrument_item_id: item.id, capture_id: capture.id, pinpoint_citation: `${t.pinpointBase}, from ${p.from_date}`, verbatim_text: p.quote, duty_holder_class: t.dutyHolderClass,
      plain_language: `GHG intensity limit ${p.target_gco2e_per_mj} ${FUELEU_TARGETS.referenceValue.unit}: ${p.reduction_percent} % below the ${FUELEU_TARGETS.referenceValue.value} reference value, from ${p.from_date}.`,
      applicability_trigger: { attribute: t.applicabilityAttribute, value: p.from_date }, jurisdiction: t.jurisdiction, mode: t.mode, frequency: "annual", ...timeline, date_of_application: p.from_date,
    });
  }
  return out;
}

/** Derive objects for items (or for candidates handed in). Dry plans only. Idempotent: a second run registers nothing new. */
export async function deriveObligationObjects(sb: Db, input: { dry: boolean; itemIds: readonly string[]; extraCandidates?: readonly Candidate[] }): Promise<RunResult<{ plan: ObjectPlan }>> {
  const ids = [...new Set([...input.itemIds, ...(input.extraCandidates ?? []).map((c) => c.instrument_item_id)])];
  const items = await fetchAllByIdChunks<ObjectItem & { id: string }>(ids, async (slice) => {
    const { data, error } = await admitItems(sb.from("intelligence_items").select("id, title, is_archived, jurisdiction_iso, instrument_identifier, canonical_instrument_key").in("id", slice));
    if (error) throw new Error(`derive-objects: intelligence_items read failed: ${error.message}`);
    return data ?? [];
  });
  const itemsById = new Map(items.filter((i) => !i.is_archived).map((i) => [i.id, i]));
  const factRows = await fetchAllByIdChunks<ClaimForObjects>([...itemsById.keys()], async (slice) => {
    const { data, error } = await sb.from("section_claim_provenance").select("id, claim_text, claim_kind, source_span, search_result_id, source_id, intelligence_item_id").eq("claim_kind", "FACT").in("intelligence_item_id", slice);
    if (error) throw new Error(`derive-objects: section_claim_provenance read failed: ${error.message}`);
    return data ?? [];
  }, { manyPerId: true });
  const claims = admissibleClaims(factRows, await readFactSuppressionsFor(sb, [...itemsById.keys()]));
  // A claim a correction took out is a statement the platform withdrew: a duty window of the capture that contains its text is withdrawn with it.
  const stands = new Set(claims.map((c) => c.id));
  const withdrawn = (itemId: string): string[] => factRows.filter((c) => c.intelligence_item_id === itemId && !stands.has(c.id)).flatMap((c) => [c.source_span, c.claim_text]).filter((t): t is string => nz(t) !== "");
  const events = await fetchAllByIdChunks<EventForDates & { intelligence_item_id: string }>([...itemsById.keys()], async (slice) => {
    const { data, error } = await sb.from("item_forward_events").select("intelligence_item_id, event_date, date_precision, event_kind, obligation_text, confidence").in("intelligence_item_id", slice);
    if (error) throw new Error(`derive-objects: item_forward_events read failed: ${error.message}`);
    return data ?? [];
  }, { manyPerId: true });
  // The item's captures (its primary text) are read once, in small chunks (a capture is a whole document): the duty windows and the FuelEU quotes are found in them, and a claim's capture is already in hand.
  const captures = await fetchAllByIdChunks<CaptureRow>([...itemsById.keys()], async (slice) => {
    const { data, error } = await sb.from("agent_run_searches").select("id, intelligence_item_id, result_content").not("result_content", "is", null).in("intelligence_item_id", slice);
    if (error) throw new Error(`derive-objects: agent_run_searches read failed: ${error.message}`);
    return data ?? [];
  }, { chunk: 10, manyPerId: true });
  const candidates: Candidate[] = [...(input.extraCandidates ?? [])];
  for (const item of itemsById.values()) {
    const own = events.filter((e) => e.intelligence_item_id === item.id);
    const held = captures.filter((c) => c.intelligence_item_id === item.id);
    const fromClaims = candidatesFromClaims(item, claims.filter((c) => c.intelligence_item_id === item.id), own);
    const taken = new Set(fromClaims.map((c) => norm(c.pinpoint_citation)));
    candidates.push(...fromClaims, ...candidatesFromCaptures(item, held, own, withdrawn(item.id)).filter((c) => !taken.has(norm(c.pinpoint_citation))), ...candidatesFromFueleuTargets(item, held, own));
  }
  const capturesById = new Map(captures.map((c) => [c.id, c]));
  const missing = [...new Set(candidates.map((c) => c.capture_id))].filter((id) => id && !capturesById.has(id));
  for (const c of await fetchAllByIdChunks<CaptureRow>(missing, async (slice) => {
    const { data, error } = await sb.from("agent_run_searches").select("id, intelligence_item_id, result_content").in("id", slice);
    if (error) throw new Error(`derive-objects: agent_run_searches read failed: ${error.message}`);
    return data ?? [];
  }, { chunk: 10 })) capturesById.set(c.id, c);
  const existing = await fetchAllByIdChunks<ExistingObject>([...itemsById.keys()], async (slice) => {
    const { data, error } = await sb.from("obligation_objects").select("obligation_id, instrument_item_id, pinpoint_citation, verbatim_text, version, supersedes").in("instrument_item_id", slice);
    if (error) throw new Error(`derive-objects: obligation_objects read failed: ${error.message}`);
    return data ?? [];
  }, { manyPerId: true });
  const plan = planObligationObjects(candidates, { itemsById, capturesById, existing });
  const counts: Record<string, number> = { candidates: candidates.length, to_insert: plan.toInsert.length, already_registered: plan.alreadyRegistered, refused: plan.refused.length, inserted: 0 };
  if (input.dry || !plan.toInsert.length) return { counts, outcome: "ok", notes: input.dry ? ["dry: nothing written"] : [], data: { plan } };
  const { data, error } = await sb.from("obligation_objects").insert(plan.toInsert.map((p) => p.row)).select("obligation_id");
  if (error) return { counts, outcome: "failed", notes: [`obligation_objects insert failed: ${error.message}`], data: { plan } };
  counts.inserted = (data ?? []).length;
  const mismatch = counts.inserted !== plan.toInsert.length;
  return { counts, outcome: mismatch ? "partial" : "ok", notes: mismatch ? [`MISMATCH: ${plan.toInsert.length} rows prepared, ${counts.inserted} confirmed inserted`] : [], data: { plan } };
}
