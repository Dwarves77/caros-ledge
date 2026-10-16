// Ported from old_repo/src/lib/research/assess.mjs (lines 1-404)
// Ported from old_repo/src/lib/research/surface-candidate.mjs (lines 1-14)
// Ported from old_repo/scripts/producers/research/research-assessment-producer.mjs (lines 26-288)
// Ported from old_repo/scripts/producers/research/research-assessment-producer.mjs (lines 311-409)
// The deterministic research assessment (no model): maturity corridors read from the item's own text, a horizon by rule R1/R3/R4, credibility, a refusal when nothing is
// forecastable, and the dated signposts the assessment states. A row is written only when a scored field changed (INV-249); the superseded row is flipped and its unscored
// signposts re-pointed to the successor; signpost ids are deterministic so a re-run writes none. The first live pass scores only items with no current row.
import { z } from "zod";

import { fetchAllByIdChunks, fetchAllRows, type Db } from "@/core/db";
import { entityId } from "@/core/entities";
import { workByDoi, type OpenAlexDeps } from "@/core/http/openalex";
import type { ParseOut, ProducerCtx, ProducerSpec } from "@/core/producers/runner";
import type { Rec } from "@/core/producers/upsert-plan";

import { aggregateAuthorityDistribution, scoreSource } from "./authority-score";
import raw from "./data/assess-rules.json";

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
  return { ...c, method: `read from the item's own recorded text against the ${ladder} (spec-03 section 2)`, evidenceIds };
}
export const assessTechnicalMaturity = (i: AssessInput) => maturity(i, TRL, "IEA-extended TRL 1-11 ladder");
export const assessCommercialMaturity = (i: AssessInput) => maturity(i, CRI, "ARENA CRI 1-6 ladder");

const bandForDate = (d: Date, now: Date): string => { const y = (d.getTime() - now.getTime()) / (365.25 * DAY); return y <= 2 ? "NOW" : y <= 5 ? "NEAR" : y <= 10 ? "MID" : "FAR"; };
const priorBandFromTrl = (low: number): string => (low >= 10 ? "NOW" : low >= 8 ? "NEAR" : low >= 5 ? "MID" : "FAR");
export interface Horizon { kind: string; band: string; rule: string; confidence: string; triggerNote: string; anchor?: { eventId: string; eventDate: string } }

/** R1: a dated statutory instrument binds you (high); R3: a named institutional roadmap dates it (medium); R4: a prior from technical maturity alone (low); else null (refusal). */
export function assessHorizon(input: AssessInput, tm: { low: number } | null, now: Date): Horizon | null {
  if (STATUTORY.test(input.text)) {
    const dated = input.forwardEvents.find((e) => e.event_date && STATUTORY.test(`${e.obligation_text ?? ""} ${input.text}`));
    const d = dated?.event_date ? new Date(dated.event_date) : null;
    if (dated && d && !Number.isNaN(d.getTime())) return { kind: "obligation", band: bandForDate(d, now), rule: "R1", confidence: "high", triggerNote: `binds on you at ${dated.event_date} because ${dated.obligation_text ?? "a dated statutory instrument named in the item's own text"}`, anchor: { eventId: dated.id, eventDate: dated.event_date as string } };
  }
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
    refusalReason: horizon ? null : "not forecastable: no dated statutory instrument, no named institutional roadmap date, and no technical-maturity corridor to prior from (spec-03 section 6's mandatory refusal state).",
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

/** DOI in the item's text to an OpenAlex work to a source record for the authority score; unresolved is no record, never a guessed one. */
export async function resolveOpenAlexSourceRecords(input: AssessInput, deps: OpenAlexDeps = {}): Promise<Rec[]> {
  const doi = extractDoiCandidate(input.text);
  const work = doi ? await workByDoi(doi, deps) : null;
  if (!doi || !work) return [];
  const inst = ((work.authorships as Array<{ institutions?: Array<{ display_name?: string; type?: string }> }> | undefined)?.[0]?.institutions?.[0]) ?? null;
  const pct = (work.citation_normalized_percentile as { value?: unknown } | undefined)?.value;
  return [{ sourceId: `doi:${doi}`, kind: "openalex", institution: inst ? { displayName: inst.display_name ?? null, type: inst.type ?? null } : null, work: { publicationDate: work.publication_date ?? null, citedByCount: typeof work.cited_by_count === "number" ? work.cited_by_count : null, fwci: typeof work.fwci === "number" ? work.fwci : null, citationNormalizedPercentile: typeof pct === "number" ? pct : null, isRetracted: work.is_retracted === true }, funding: null }];
}

/** The live candidates: verified, non-archived research items with NO current assessment (the first pass never re-scores; `itemIds` names the items to re-score, current assessment or not), at most `limit`, with their source tier and forward events. */
export async function fetchLiveCandidates(sb: Db, limit?: number, opts: { itemIds?: readonly string[] } = {}): Promise<AssessInput[]> {
  const items = await fetchAllRows<Rec>((from, to) => sb.from("intelligence_items").select("id,item_type,domain,added_date,title,what_is_it,why_matters,full_brief,source_id,instrument_entity_id").or(RESEARCH_CANDIDATE_OR).eq("is_archived", false).eq("provenance_status", "verified").order("id", { ascending: true }).range(from, to) as never, { cap: 100_000 });
  const only = opts.itemIds ? new Set(opts.itemIds) : null;
  const admitted = items.filter((r) => isResearchCandidate(r.item_type, r.domain) && (!only || only.has(String(r.id))));
  const have = new Set(only ? [] : (await fetchAllByIdChunks(admitted.map((r) => String(r.id)), async (ids) => { const { data, error } = await sb.from("research_assessments_current").select("item_id").in("item_id", ids); if (error) throw new Error(`reading research_assessments_current failed: ${error.message}`); return (data ?? []) as Array<{ item_id: string }>; })).map((r) => r.item_id));
  const needing = admitted.filter((r) => !have.has(String(r.id)));
  const picked = typeof limit === "number" && limit > 0 ? needing.slice(0, limit) : needing;
  const tiers = new Map((await fetchAllByIdChunks(picked.map((r) => String(r.source_id)).filter(Boolean), async (ids) => { const { data, error } = await sb.from("sources").select("id,base_tier").in("id", ids); if (error) throw new Error(`reading sources failed: ${error.message}`); return (data ?? []) as Array<{ id: string; base_tier: number | null }>; })).map((s) => [s.id, s.base_tier] as const));
  const events = await fetchAllByIdChunks(picked.map((r) => String(r.id)), async (ids) => { const { data, error } = await sb.from("item_forward_events").select("id,intelligence_item_id,event_date,event_kind,obligation_text").in("intelligence_item_id", ids); if (error) throw new Error(`reading item_forward_events failed: ${error.message}`); return (data ?? []) as Array<Rec>; }, { manyPerId: true });
  const byItem = new Map<string, ForwardEvent[]>();
  for (const e of events) byItem.set(String(e.intelligence_item_id), [...(byItem.get(String(e.intelligence_item_id)) ?? []), { id: String(e.id), kind: e.event_kind as string, event_date: e.event_date as string | null, obligation_text: e.obligation_text as string | null, source_citation: null }]);
  return picked.map((r) => toAssessmentInput({ ...r, source_base_tier: tiers.get(String(r.source_id)) ?? null, forward_events: byItem.get(String(r.id)) ?? [] }));
}

const unwrap = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what} failed: ${r.error.message}`);
  return r.data as T;
};

export const researchAssessment: ProducerSpec = {
  name: "research-assessment",
  table: "research_assessments",
  licenceKey: null,
  enabled: false,
  enabledRuling: "operator 2026-10-04: no data population before every build layer is complete (ADR-023)",
  killSwitchEnv: "RESEARCH_ASSESSMENT_PRODUCER_ENABLED",
  gap: "no assessment candidates: pass candidate inputs, or run with a database client to read the live research items",
  /** The document is the JSON array of assessment inputs; with a client and no injected input the live candidates are read (bounded by input.limit). */
  async fetchDoc(ctx: ProducerCtx) {
    return { text: ctx.sb ? JSON.stringify(await fetchLiveCandidates(ctx.sb, ctx.input.limit)) : "" };
  },
  async parse(doc, ctx): Promise<ParseOut<Rec>> {
    const inputs = JSON.parse(doc.text ?? "[]") as AssessInput[];
    const rows: Rec[] = [];
    const signposts: Record<string, SignpostSpec[]> = {};
    const oa: OpenAlexDeps = { fetch: ctx.deps.fetch as never, ...(ctx.deps.sleep ? { sleep: ctx.deps.sleep } : {}) };
    for (const input of inputs) {
      const records = await resolveOpenAlexSourceRecords(input, oa);
      const computed = assessItem(records.length ? { ...input, sourceRecords: records } : input, { now: ctx.now() });
      rows.push(toRow(computed));
      signposts[input.id] = computed.signposts;
    }
    ctx.state.signposts = signposts;
    return { rows, warnings: [], counts: { candidates: inputs.length } };
  },
  /** Apply: write only changed assessments (flip the superseded row first, restore it if the insert fails), re-point its unscored signposts, then write the deterministic signposts. */
  async persist(ctx, rows) {
    const sb = ctx.sb as Db;
    const ids = rows.map((r) => String(r.item_id));
    const current = new Map((await fetchAllByIdChunks(ids, async (chunkIds) => unwrap(await sb.from("research_assessments_current").select("*").in("item_id", chunkIds), "reading research_assessments_current") as Rec[])).map((r) => [String(r.item_id), r]));
    const signposts = ctx.state.signposts as Record<string, SignpostSpec[]>;
    const c = { unchanged: 0, written: 0, signposts_repointed: 0, signposts_written: 0, signposts_existing: 0, signposts_skipped_no_assessment_id: 0 };
    const planned: Array<{ sp: SignpostSpec; assessmentId: string | null }> = [];
    for (const row of rows) {
      const itemId = String(row.item_id);
      const cur = current.get(itemId) ?? null;
      if (!hasChanged(cur, row)) {
        c.unchanged += 1;
        for (const sp of signposts[itemId] ?? []) planned.push({ sp, assessmentId: cur ? String(cur.id) : null });
        continue;
      }
      if (cur) unwrap(await sb.from("research_assessments").update({ is_current: false }).eq("id", cur.id), "flipping the superseded assessment");
      const ins = await sb.from("research_assessments").insert({ ...row, supersedes: cur ? cur.id : null } as never).select("id").single();
      if (ins.error || !ins.data) {
        if (cur) await sb.from("research_assessments").update({ is_current: true }).eq("id", cur.id);
        throw new Error(`insert of the assessment for ${itemId} failed: ${ins.error?.message ?? "no row returned"}`);
      }
      const newId = (ins.data as { id: string }).id;
      c.written += 1;
      if (cur) {
        const rp = await sb.from("signposts").update({ assessment_id: newId }).eq("assessment_id", cur.id).is("outcome", null).select("entity_id");
        c.signposts_repointed += (unwrap(rp, "re-pointing signposts") ?? []).length;
      }
      for (const sp of signposts[itemId] ?? []) planned.push({ sp, assessmentId: newId });
    }
    const unique = new Map<string, { sp: SignpostSpec; assessmentId: string | null }>();
    for (const p of planned) if (!unique.has(entityId("signpost", p.sp.seed))) unique.set(entityId("signpost", p.sp.seed), p);
    const existing = new Set((await fetchAllByIdChunks([...unique.keys()], async (chunkIds) => unwrap(await sb.from("signposts").select("entity_id").in("entity_id", chunkIds), "reading signposts") as Array<{ entity_id: string }>)).map((r) => r.entity_id));
    for (const [id, p] of unique) {
      if (existing.has(id)) { c.signposts_existing += 1; continue; }
      if (!p.assessmentId) { c.signposts_skipped_no_assessment_id += 1; continue; }
      unwrap(await sb.from("entities").upsert({ entity_id: id, kind: "signpost", canonical_name: p.sp.label, status: "active" } as never, { onConflict: "entity_id" }), "writing the signpost entity");
      unwrap(await sb.from("signposts").insert({ entity_id: id, assessment_id: p.assessmentId, watches: p.sp.watches, predicate: p.sp.predicate, direction: p.sp.direction } as never), "writing the signpost");
      c.signposts_written += 1;
    }
    return c;
  },
};
