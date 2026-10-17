// Ported from old_repo/src/lib/research/read-assessments.mjs (lines 1-107)
// Ported from old_repo/src/lib/research/read-signposts.mjs (lines 1-57)
// Ported from old_repo/src/lib/research/read-signposts.mjs (lines 79-107)
// The render-ready view of a stored assessment: ONE column list and ONE corridor label rule (the old tree had three of each), the horizon words, the signposts with the watched entity's name and the
// append-only history entries. Pure: a reader supplies rows, a component draws the view; nothing here fetches or reads a clock.
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
export const corridorLabel = (prefix: "TRL" | "CRI", low: number, high: number): string => (low === high ? `${prefix} ${low}` : `${prefix} ${low}-${high}`);
export const HORIZON_BAND_WORDS: Readonly<Record<string, string>> = { NOW: "now, within 2 years", NEAR: "near, 2 to 5 years", MID: "mid, 5 to 10 years", FAR: "far, beyond 10 years" };
export const HORIZON_KIND_WORDS: Readonly<Record<string, string>> = { obligation: "Obligation horizon", availability: "Availability horizon", economic: "Economic horizon" };
export const HORIZON_RULE_WORDS: Readonly<Record<string, string>> = { R1: "a dated statutory instrument", R3: "a named institutional roadmap", R4: "inferred from maturity, no dated evidence" };

export interface Corridor {
  low: number;
  high: number;
  label: string;
  method: string | null;
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
}

/** The stored method names the spec it was read against; a customer reads the method without the document reference. */
const plainMethod = (m: string | null): string | null => (m ? m.replace(/\s*\(spec-\d+[^)]*\)/gi, "").trim() : null);
const corridor = (prefix: "TRL" | "CRI", low: number | null, high: number | null, method: string | null): Corridor | null => (low != null && high != null ? { low, high, label: corridorLabel(prefix, low, high), method: plainMethod(method) } : null);

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
/** The list row's meta segment, e.g. "NEAR horizon"; null for a refusal (the row says nothing rather than a placeholder). */
export const horizonMetaLabel = (v: AssessmentView | null | undefined): string | null => (v?.horizon ? `${v.horizon.band} horizon` : null);
export const refusalText = (reason: string | null): string => reason || "not forecastable, and the conditional structure could not be determined";

export interface SignpostRow {
  entity_id: string;
  assessment_id: string;
  watches: string;
  predicate: { op?: string; field?: string; by?: string; basis?: string; metric?: string; gte?: number; relation?: string; n?: number } | null;
  direction: string;
  fired_at: string | null;
}
/** One customer sentence for a signpost predicate; an unknown op says so and guesses nothing. */
export function summarizePredicate(p: SignpostRow["predicate"]): string {
  if (!p || typeof p !== "object" || !p.op) return "no condition recorded";
  if (p.op === "date_passed") return p.basis === "movement_by_date" && p.by ? `expects a recorded change on what it watches by ${p.by}` : "fires once a recorded date has passed";
  if (p.op === "threshold") return p.metric && p.gte != null ? `fires once ${p.metric} reaches ${p.gte}` : "fires once a measure crosses its threshold";
  if (p.op === "count_gte") return p.relation && p.n != null ? `fires once ${p.n} or more ${p.relation} are recorded` : "fires once a count reaches its floor";
  return "condition not recognised";
}
export interface SignpostView {
  entityId: string;
  watches: string;
  /** The watched entity's name when the reader could resolve it, else null (the raw id is never printed). */
  watchesLabel: string | null;
  direction: string;
  summary: string;
  firedAt: string | null;
}
export const selectSignpostView = (row: SignpostRow, labelOf: (entityId: string) => string | null): SignpostView => ({ entityId: row.entity_id, watches: row.watches, watchesLabel: labelOf(row.watches), direction: row.direction, summary: summarizePredicate(row.predicate), firedAt: row.fired_at });

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
