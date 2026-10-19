// Ported from old_repo/src/lib/research/assess.mjs (lines 1-404)
// Ported from old_repo/src/lib/research/surface-candidate.mjs (lines 1-14)
// Ported from old_repo/scripts/producers/research/research-assessment-producer.mjs (lines 26-288)
// The pure research assessment (no model, no I/O): maturity corridors read from the item's own text, the horizon cascade (R1 a dated statutory event whose OWN text names the instrument, R3 a named
// roadmap date, R4 a prior from technical maturity, else a first-class refusal), credibility, the dated signposts an anchored horizon states. The producer (../assessment-producer.ts) writes it.
import { z } from "zod";

import type { Rec } from "@/core/producers/upsert-plan";

import { aggregateAuthorityDistribution, scoreSource } from "../authority-score";
import raw from "../data/assess-rules.json";

const rules = z.object({ trl: z.array(z.object({ low: z.number(), high: z.number(), pattern: z.string() })), cri: z.array(z.object({ low: z.number(), high: z.number(), pattern: z.string() })), roadmapBodies: z.string(), statutory: z.string() }).parse(raw);
const compile = (ps: typeof rules.trl) => ps.map((p) => ({ low: p.low, high: p.high, re: new RegExp(p.pattern, "i") }));
const TRL = compile(rules.trl);
const CRI = compile(rules.cri);
const ROADMAP = new RegExp(rules.roadmapBodies, "i");
const STATUTORY = new RegExp(rules.statutory, "i");
const DAY = 86_400_000;

export const COMPUTED_BY = "research-assessment-producer@1";
export const RESEARCH_CANDIDATE_OR = "domain.eq.7,item_type.eq.research_finding";
export const isResearchCandidate = (itemType: unknown, domain: unknown): boolean => (typeof domain === "number" ? domain : null) === 7 || itemType === "research_finding";

export interface ForwardEvent { id: string; kind?: string; event_date: string | null; obligation_text: string | null; source_citation: string | null }
export interface AssessInput {
  id: string; itemType?: string; addedDate?: string | null; text: string; sourceTier: number | null; citationCount: number | null; biasTags?: unknown[]; forwardEvents: ForwardEvent[]; entityId: string | null; sourceRecords?: Rec[];
}
type Corridor = { low: number; high: number };
const readCorridor = (text: string, ps: typeof TRL): Corridor | null => {
  const hit = ps.find((p) => p.re.test(text || ""));
  return hit ? { low: hit.low, high: hit.high } : null;
};
function maturity(input: AssessInput, ps: typeof TRL, ladder: string) {
  const c = readCorridor(input.text, ps);
  if (!c) return null;
  const evidenceIds = [input.id, ...input.forwardEvents.filter((e) => { const ec = e.obligation_text ? readCorridor(e.obligation_text, ps) : null; return ec && ec.low === c.low && ec.high === c.high; }).map((e) => e.id)];
  return { ...c, method: ladder, evidenceIds };
}
/** The method is a code (assessment-copy.json holds its sentence); the row never carries prose or a specification reference. */
export const assessTechnicalMaturity = (i: AssessInput) => maturity(i, TRL, "text_trl");
export const assessCommercialMaturity = (i: AssessInput) => maturity(i, CRI, "text_cri");

const bandForDate = (d: Date, now: Date): string => { const y = (d.getTime() - now.getTime()) / (365.25 * DAY); return y <= 2 ? "NOW" : y <= 5 ? "NEAR" : y <= 10 ? "MID" : "FAR"; };
const priorBandFromTrl = (low: number): string => (low >= 10 ? "NOW" : low >= 8 ? "NEAR" : low >= 5 ? "MID" : "FAR");
export interface Horizon { kind: string; band: string; rule: string; confidence: string; triggerNote: string; anchor?: { eventId: string; eventDate: string } }

/** R1: a dated event whose OWN text names a statutory instrument binds you (high; the item text alone never anchors it); R3: a named institutional roadmap dates it (medium); R4: a prior from technical maturity alone (low); else null (refusal). */
export function assessHorizon(input: AssessInput, tm: { low: number } | null, now: Date): Horizon | null {
  const dated = input.forwardEvents.find((e) => e.event_date && STATUTORY.test(`${e.obligation_text ?? ""} ${e.source_citation ?? ""}`) && !Number.isNaN(new Date(e.event_date).getTime()));
  if (dated?.event_date) return { kind: "obligation", band: bandForDate(new Date(dated.event_date), now), rule: "R1", confidence: "high", triggerNote: `binds on you at ${dated.event_date} because ${dated.obligation_text ?? "a dated statutory instrument named in the event's own text"}`, anchor: { eventId: dated.id, eventDate: dated.event_date } };
  const road = input.forwardEvents.find((e) => e.event_date && (ROADMAP.test(e.source_citation ?? "") || ROADMAP.test(e.obligation_text ?? "")));
  const rd = road?.event_date ? new Date(road.event_date) : null;
  if (road && rd && !Number.isNaN(rd.getTime())) {
    const body = (road.source_citation ?? road.obligation_text ?? "").match(ROADMAP)?.[0] ?? "a named institutional roadmap";
    return { kind: "availability", band: bandForDate(rd, now), rule: "R3", confidence: "medium", triggerNote: `${body}'s roadmap dates this at ${road.event_date}, tagged with the issuing body's own scenario assumption`, anchor: { eventId: road.id, eventDate: road.event_date as string } };
  }
  return tm ? { kind: "availability", band: priorBandFromTrl(tm.low), rule: "R4", confidence: "low", triggerNote: "inferred from maturity, no dated evidence" } : null;
}
export const assessEvidenceScore = (i: AssessInput): "limited" | "medium" | "robust" | null => (typeof i.citationCount !== "number" || i.citationCount < 0 ? null : i.citationCount === 0 ? "limited" : i.citationCount < 5 ? "medium" : "robust");
export function extractDoiCandidate(text: string | null | undefined): string | null {
  const m = (text || "").match(/\b10\.\d{4,9}\/[^\s"'<>)\]]+/);
  return m ? m[0].replace(/[.,;]+$/, "") : null;
}
export function resolveAuthoritySources(input: AssessInput): Rec[] {
  const out: Rec[] = (input.sourceRecords ?? []).filter((r) => r && r.sourceId);
  for (const ev of input.forwardEvents) {
    const m = `${ev.source_citation ?? ""} ${ev.obligation_text ?? ""}`.match(ROADMAP);
    if (m) out.push({ sourceId: `forward-event:${ev.id}`, kind: "grey_literature", displayName: m[0] });
  }
  return out;
}
/** Resolved source records are scored; with none, the source tier maps to a single-source distribution (tier 1-2 high, 3-5 medium, 6+ vendor-flagged). A null tier is no score. */
export function assessAuthorityScore(input: AssessInput, now: Date) {
  const resolved = resolveAuthoritySources(input);
  if (resolved.length) return aggregateAuthorityDistribution(resolved.map((r) => scoreSource(r, { now })));
  const t = input.sourceTier;
  if (typeof t !== "number") return null;
  return t <= 2 ? { highAuthorityIndependent: 1, medium: 0, vendorFlagged: 0 } : t <= 5 ? { highAuthorityIndependent: 0, medium: 1, vendorFlagged: 0 } : { highAuthorityIndependent: 0, medium: 0, vendorFlagged: 1 };
}
export interface SignpostSpec { seed: string; itemId: string; forwardEventId: string; watches: string; direction: "confirms"; predicate: Rec; label: string }
export function assessSignposts(input: AssessInput, horizon: Horizon | null, now: Date): SignpostSpec[] {
  if (!horizon?.anchor || !input.entityId) return [];
  const due = new Date(horizon.anchor.eventDate);
  if (Number.isNaN(due.getTime()) || due.getTime() <= now.getTime()) return [];
  const by = /^\d{4}-\d{2}-\d{2}/.test(horizon.anchor.eventDate) ? horizon.anchor.eventDate.slice(0, 10) : due.toISOString().slice(0, 10);
  return [{ seed: `signpost:${input.id}:${horizon.anchor.eventId}`, itemId: input.id, forwardEventId: horizon.anchor.eventId, watches: input.entityId, direction: "confirms", predicate: { op: "date_passed", field: "occurred_at", by, basis: "movement_by_date", horizon_rule: horizon.rule, forward_event_id: horizon.anchor.eventId }, label: `Signpost, ${horizon.kind} horizon read ${horizon.rule}: movement on the watched entity by ${by} (item ${input.id})` }];
}
/** The whole assessment of one item. CONFIRMED only for R1/R3 (a dated instrument or roadmap); every prior is a HYPOTHESIS. Pure: the clock is `opts.now`. */
export function assessItem(input: AssessInput, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const technicalMaturity = assessTechnicalMaturity(input);
  const horizon = assessHorizon(input, technicalMaturity, now);
  return {
    itemId: input.id, technicalMaturity, commercialMaturity: assessCommercialMaturity(input), horizon,
    refusalReason: horizon ? null : "no_dated_basis",
    credibilityEvidenceScore: assessEvidenceScore(input), credibilityAuthorityScore: assessAuthorityScore(input, now),
    statusToken: horizon && (horizon.rule === "R1" || horizon.rule === "R3") ? "CONFIRMED" : "HYPOTHESIS", signposts: assessSignposts(input, horizon, now),
  };
}
export type Assessed = ReturnType<typeof assessItem>;

export function toAssessmentInput(row: Rec): AssessInput {
  return { id: String(row.id), itemType: row.item_type as string, addedDate: (row.added_date as string) ?? null, text: [row.title, row.what_is_it, row.why_matters, row.full_brief].filter(Boolean).join(" "), sourceTier: typeof row.source_base_tier === "number" ? row.source_base_tier : null, citationCount: typeof row.citation_count === "number" ? row.citation_count : null, biasTags: (row.bias_tags as unknown[]) ?? [], forwardEvents: (row.forward_events as ForwardEvent[]) ?? [], entityId: (row.instrument_entity_id as string) ?? null };
}
/** The research_assessments row of an assessment. */
export function toRow(c: Assessed, o: { supersedes?: string | null } = {}): Rec {
  const tm = c.technicalMaturity, cm = c.commercialMaturity, h = c.horizon;
  return { item_id: c.itemId, supersedes: o.supersedes ?? null, is_current: true, technical_maturity_low: tm?.low ?? null, technical_maturity_high: tm?.high ?? null, technical_maturity_method: tm?.method ?? null, technical_maturity_evidence_ids: tm?.evidenceIds ?? [], commercial_maturity_low: cm?.low ?? null, commercial_maturity_high: cm?.high ?? null, commercial_maturity_method: cm?.method ?? null, commercial_maturity_evidence_ids: cm?.evidenceIds ?? [], horizon_kind: h?.kind ?? null, horizon_band: h?.band ?? null, horizon_rule: h?.rule ?? null, horizon_confidence: h?.confidence ?? null, horizon_trigger_note: h?.triggerNote ?? null, refusal_reason: c.refusalReason, credibility_evidence_score: c.credibilityEvidenceScore, credibility_authority_score: c.credibilityAuthorityScore, computed_by: COMPUTED_BY, status_token: c.statusToken };
}
const COMPARED = ["technical_maturity_low", "technical_maturity_high", "commercial_maturity_low", "commercial_maturity_high", "horizon_band", "horizon_rule", "horizon_kind", "refusal_reason", "credibility_evidence_score", "status_token"] as const;
/** True when no current row exists or any scored field differs: an unchanged item writes nothing. */
export const hasChanged = (current: Rec | null | undefined, row: Rec): boolean => !current || COMPARED.some((k) => (current[k] ?? null) !== (row[k] ?? null));
