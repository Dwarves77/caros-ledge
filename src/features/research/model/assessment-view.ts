// Ported from old_repo/src/lib/research/read-assessments.mjs (lines 1-107)
// Ported from old_repo/src/lib/research/read-signposts.mjs (lines 1-57)
// Ported from old_repo/src/lib/research/read-signposts.mjs (lines 79-107)
// The render-ready view of a stored assessment: ONE column list and ONE corridor label rule (the old tree had three of each), the horizon words, the signposts with the watched entity's name and the
// append-only history entries. Pure: a reader supplies rows, a component draws the view; nothing here fetches or reads a clock.
import { z } from "zod";

import copyJson from "./data/assessment-copy.json";
import stanceJson from "./data/assessment-stance.json";

const STANCE = z
  .object({
    stances: z.array(z.string().min(1)).min(1),
    horizons: z.array(z.string().min(1)).min(1),
    rules: z.array(z.object({ band: z.string().optional(), kind: z.string().optional(), technicalHighAtLeast: z.number().optional(), commercialHighAtLeast: z.number().optional(), stance: z.string(), horizon: z.string() })).min(1),
  })
  .superRefine((d, ctx) => {
    for (const r of d.rules) if (!d.stances.includes(r.stance) || !d.horizons.includes(r.horizon)) ctx.addIssue({ code: "custom", message: `rule names a stance or horizon outside the lists: ${r.stance} ${r.horizon}` });
    for (const r of d.rules) if (r.band !== undefined && r.band !== r.horizon) ctx.addIssue({ code: "custom", message: `a ${r.band} rule must name the ${r.band} horizon, not ${r.horizon}` });
  })
  .parse(stanceJson);
const COPY = copyJson as { refusal: Record<string, string>; genericRefusal: string; method: Record<string, string>; predicate: Record<string, string> };
export const ASSESSMENT_COLUMNS =
  "id, item_id, supersedes, is_current, lifecycle_state, technical_maturity_low, technical_maturity_high, technical_maturity_method, commercial_maturity_low, commercial_maturity_high, commercial_maturity_method, horizon_kind, horizon_band, horizon_rule, horizon_confidence, horizon_trigger_note, refusal_reason, credibility_evidence_score, credibility_authority_score, status_token, computed_at";
export const SIGNPOST_COLUMNS = "entity_id, assessment_id, watches, predicate, direction, fired_at";

/** The distribution stored by the producer: a count per bucket, never a mean. */
export interface AuthorityDistribution {
  highAuthorityIndependent?: number;
  medium?: number;
  vendorFlagged?: number;
  unknown?: number;
  integrityFlagged?: number;
  sources?: Array<{ sourceId?: string; roleClass?: string; bucket?: string }>;
}
export interface AssessmentRow {
  id: string;
  item_id: string;
  supersedes: string | null;
  is_current: boolean;
  lifecycle_state: string | null;
  technical_maturity_low: number | null;
  technical_maturity_high: number | null;
  technical_maturity_method: string | null;
  commercial_maturity_low: number | null;
  commercial_maturity_high: number | null;
  commercial_maturity_method: string | null;
  horizon_kind: string | null;
  horizon_band: string | null;
  horizon_rule: string | null;
  horizon_confidence: string | null;
  horizon_trigger_note: string | null;
  refusal_reason: string | null;
  credibility_evidence_score: string | null;
  credibility_authority_score: AuthorityDistribution | null;
  status_token: string;
  computed_at: string;
}

/** "TRL 8" for a point corridor, "TRL 8-9" for a span (the old card printed "8-8"). */
const corridorLabel = (prefix: "TRL" | "CRI", low: number, high: number): string => (low === high ? `${prefix} ${low}` : `${prefix} ${low}-${high}`);
export const HORIZON_BAND_WORDS: Readonly<Record<string, string>> = { NOW: "now, within 2 years", NEAR: "near, 2 to 5 years", MID: "mid, 5 to 10 years", FAR: "far, beyond 10 years" };
export const HORIZON_KIND_WORDS: Readonly<Record<string, string>> = { obligation: "Obligation horizon", availability: "Availability horizon", economic: "Economic horizon" };

export interface Corridor {
  low: number;
  high: number;
  label: string;
  method: string | null;
}

/** The classification of a stored assessment into a stance token and the horizon band it was read for, by the ordered rules in data/assessment-stance.json; no sentence. A UI copy table words each token. */
export interface AssessmentForwardOutlook {
  stance: string;
  horizon: string;
}

export interface AssessmentView {
  id: string;
  itemId: string;
  supersedes: string | null;
  technical: Corridor | null;
  commercial: Corridor | null;
  horizon: { kind: string; band: string; rule: string; confidence: string | null; triggerNote: string | null } | null;
  refusalReason: string | null;
  evidenceScore: string | null;
  authority: AuthorityDistribution | null;
  /** True for a horizon anchored to a dated instrument or roadmap (R1, R3); false for an inference or a refusal. */
  anchored: boolean;
  lifecycleState: string | null;
  computedAt: string;
  forwardOutlook: AssessmentForwardOutlook | null;
}

/** The stored method is a code; its sentence is in assessment-copy.json, and a stored value that is not a known code (an older row's prose) is not printed. */
const methodWords = (m: string | null): string | null => (m !== null && Object.hasOwn(COPY.method, m) ? (COPY.method[m] as string) : null);
const corridor = (prefix: "TRL" | "CRI", low: number | null, high: number | null, method: string | null): Corridor | null => (low != null && high != null ? { low, high, label: corridorLabel(prefix, low, high), method: methodWords(method) } : null);

function deriveAssessmentForwardOutlook(row: AssessmentRow): AssessmentForwardOutlook | null {
  if (row.refusal_reason) return null;
  const hit = STANCE.rules.find(
    (r) =>
      (r.band === undefined || r.band === row.horizon_band) &&
      (r.kind === undefined || r.kind === row.horizon_kind) &&
      (r.technicalHighAtLeast === undefined || (row.technical_maturity_high !== null && row.technical_maturity_high >= r.technicalHighAtLeast)) &&
      (r.commercialHighAtLeast === undefined || (row.commercial_maturity_high !== null && row.commercial_maturity_high >= r.commercialHighAtLeast)),
  );
  return hit ? { stance: hit.stance, horizon: hit.horizon } : null;
}

export function selectAssessmentView(row: AssessmentRow | null | undefined): AssessmentView | null {
  if (!row) return null;
  const horizon = row.horizon_band && row.horizon_rule ? { kind: row.horizon_kind ?? "availability", band: row.horizon_band, rule: row.horizon_rule, confidence: row.horizon_confidence, triggerNote: row.horizon_trigger_note } : null;
  return {
    id: row.id,
    itemId: row.item_id,
    supersedes: row.supersedes,
    technical: corridor("TRL", row.technical_maturity_low, row.technical_maturity_high, row.technical_maturity_method),
    commercial: corridor("CRI", row.commercial_maturity_low, row.commercial_maturity_high, row.commercial_maturity_method),
    horizon,
    refusalReason: row.refusal_reason,
    evidenceScore: row.credibility_evidence_score,
    authority: row.credibility_authority_score,
    anchored: horizon?.rule === "R1" || horizon?.rule === "R3",
    lifecycleState: row.lifecycle_state,
    computedAt: row.computed_at,
    forwardOutlook: deriveAssessmentForwardOutlook(row),
  };
}
export function selectAssessmentViewsByItemId(rows: readonly AssessmentRow[]): Map<string, AssessmentView> {
  const out = new Map<string, AssessmentView>();
  for (const r of rows) {
    const v = selectAssessmentView(r);
    if (v) out.set(v.itemId, v);
  }
  return out;
}
/** The list row's meta segment from the horizon words ("near, 2 to 5 years"); null for a refusal and for a band the table does not hold (the row says nothing rather than a token). */
export const horizonMetaLabel = (v: AssessmentView | null | undefined): string | null => (v?.horizon && Object.hasOwn(HORIZON_BAND_WORDS, v.horizon.band) ? (HORIZON_BAND_WORDS[v.horizon.band] as string) : null);
/** The one sentence for a stored refusal code; any other stored text (an older row's prose) reads as the generic sentence and is never printed. */
export const refusalText = (reason: string | null): string => (reason !== null && Object.hasOwn(COPY.refusal, reason) ? (COPY.refusal[reason] as string) : COPY.genericRefusal);

export interface SignpostRow {
  entity_id: string;
  assessment_id: string;
  watches: string;
  predicate: { op?: string; field?: string; by?: string; basis?: string; metric?: string; gte?: number; relation?: string; n?: number } | null;
  direction: string;
  fired_at: string | null;
}
/** The kinds a stored predicate classifies into (the keys of the predicate copy in assessment-copy.json, which words each; "bare" kinds are a known op stored without the parameters its wording needs). */
export type PredicateKind = keyof typeof copyJson.predicate;
/** A signpost predicate as data: its kind token and its own stored parameters. No sentence (ADR-050); an unknown op is "unrecognised" and guesses nothing. */
export interface PredicateView {
  kind: PredicateKind;
  by: string | null;
  metric: string | null;
  gte: number | null;
  relation: string | null;
  n: number | null;
}
function summarizePredicate(p: SignpostRow["predicate"]): PredicateView {
  const view = (kind: PredicateKind): PredicateView => ({ kind, by: p?.by ?? null, metric: p?.metric ?? null, gte: p?.gte ?? null, relation: p?.relation ?? null, n: p?.n ?? null });
  if (!p || typeof p !== "object" || !p.op) return view("none");
  if (p.op === "date_passed") return view(p.basis === "movement_by_date" && p.by ? "movement_by_date" : "date_passed");
  if (p.op === "threshold") return view(p.metric && p.gte != null ? "threshold" : "threshold_bare");
  if (p.op === "count_gte") return view(p.relation && p.n != null ? "count_gte" : "count_bare");
  return view("unrecognised");
}
/** The words for a predicate: its kind's wording with the predicate's own stored parameters in the {slots}. */
export const predicateWords = (p: PredicateView): string => (COPY.predicate[p.kind] ?? "").replace(/\{(\w+)\}/g, (_, k: keyof PredicateView) => String(p[k] ?? ""));
export interface SignpostView {
  entityId: string;
  watches: string;
  /** The watched entity's name when the reader could resolve it, else null (the raw id is never printed). */
  watchesLabel: string | null;
  direction: string;
  predicate: PredicateView;
  firedAt: string | null;
}
export const selectSignpostView = (row: SignpostRow, labelOf: (entityId: string) => string | null): SignpostView => ({ entityId: row.entity_id, watches: row.watches, watchesLabel: labelOf(row.watches), direction: row.direction, predicate: summarizePredicate(row.predicate), firedAt: row.fired_at });

export interface HistoryEntry {
  id: string;
  supersedes: string | null;
  computedAt: string;
  isCurrent: boolean;
  lifecycleState: string | null;
  technicalLabel: string | null;
  commercialLabel: string | null;
  horizonBand: string | null;
  anchored: boolean;
}
export const selectHistoryEntry = (v: AssessmentView, isCurrent: boolean): HistoryEntry => ({ id: v.id, supersedes: v.supersedes, computedAt: v.computedAt, isCurrent, lifecycleState: v.lifecycleState, technicalLabel: v.technical?.label ?? null, commercialLabel: v.commercial?.label ?? null, horizonBand: v.horizon?.band ?? null, anchored: v.anchored });
