// Ported from old_repo/src/lib/connections/gaps.mjs (lines 1-124)
// Ported from old_repo/src/lib/connections/anticipate.mjs (lines 1-129)
// Coverage gaps of a theme against the workspace profile, and anticipated targets from forward events with thin coverage. Jurisdictions compare as
// jurisdiction ENTITIES (canonical code, then entity id), never as raw strings (B-0238/2150/2151): "uk" and "GB" are one jurisdiction.
import { canonicalJurisdictionCode, entityId, GENERIC_JURISDICTIONS } from "@/core/entities/id";

import { buildSubjectRef, ANTICIPATE_NAMESPACE, createdBy, GAP_NAMESPACE, type Finding } from "./flags";
import type { Theme } from "./cluster";

const lc = (s: unknown): string => String(s ?? "").toLowerCase().trim();

/** The entity id of a jurisdiction code on the canonical spelling; null for a generic scope or an empty code. */
function jurisdictionKey(code: unknown): string | null {
  const c = canonicalJurisdictionCode(code);
  return c && !GENERIC_JURISDICTIONS.has(lc(c)) ? entityId("jurisdiction", c) : null;
}

export interface Gap {
  type: "jurisdiction_span_gap" | "surface_gap" | "pivot_operations_gap";
  category: string;
  subject_type: string;
  subject_ref: string;
  description: string;
  recommended_actions: string[];
  evidence: Record<string, unknown>;
}

function homeJurisdictions(profile: { jurisdictions?: Record<string, unknown> } | undefined): string[] {
  const map = profile && typeof profile.jurisdictions === "object" ? profile.jurisdictions : null;
  if (!map) return [];
  let maxW = -Infinity;
  const specific: [string, number][] = [];
  for (const [iso, w] of Object.entries(map)) {
    if (GENERIC_JURISDICTIONS.has(lc(iso))) continue;
    const weight = typeof w === "number" && Number.isFinite(w) ? w : 0;
    specific.push([iso, weight]);
    if (weight > maxW) maxW = weight;
  }
  return specific.filter(([, w]) => w === maxW).map(([iso]) => iso).sort();
}

/** Gaps in the theme set: a theme spanning several jurisdictions with none of the workspace's home ones, regulation plus research with no market item, a pivot with no operations counterpart. */
export function detectGaps(themes: readonly Pick<Theme, "id" | "members" | "surfaces" | "pivots">[], opts: { profile?: { jurisdictions?: Record<string, unknown> }; jurisdictionsByMember?: Record<string, string[] | string | null | undefined> } = {}): Gap[] {
  const gaps: Gap[] = [];
  for (const theme of themes) {
    if (!theme || typeof theme.id !== "string") continue;
    const members = Array.isArray(theme.members) ? theme.members : [];
    const surfaces = new Set(Array.isArray(theme.surfaces) ? theme.surfaces : []);
    if (opts.jurisdictionsByMember) {
      const spanned = new Map<string, string>();
      for (const id of members) {
        const raw = opts.jurisdictionsByMember[id];
        for (const code of Array.isArray(raw) ? raw : raw ? [raw] : []) {
          const key = jurisdictionKey(code);
          if (key) spanned.set(key, canonicalJurisdictionCode(code) as string);
        }
      }
      if (spanned.size >= 2) {
        const names = [...spanned.values()].sort();
        for (const home of homeJurisdictions(opts.profile)) {
          const homeKey = jurisdictionKey(home);
          if (!homeKey || spanned.has(homeKey)) continue;
          gaps.push({
            type: "jurisdiction_span_gap", category: "coverage_gap", subject_type: "system", subject_ref: buildSubjectRef(theme.id),
            description: `Theme ${theme.id} spans ${spanned.size} jurisdictions (${names.join(", ")}) with no member in ${home}, a jurisdiction this workspace weights as home.`,
            recommended_actions: [`Confirm whether ${home} coverage for this theme exists outside this cluster before treating it as a real gap.`],
            evidence: { themeId: theme.id, spannedJurisdictions: names, missingHome: home, memberCount: members.length },
          });
        }
      }
    }
    if (surfaces.has("regulations") && surfaces.has("research") && !surfaces.has("market")) {
      gaps.push({
        type: "surface_gap", category: "coverage_gap", subject_type: "system", subject_ref: buildSubjectRef(theme.id),
        description: `Theme ${theme.id} connects regulation and research signals (${members.length} members) with no market signal tracked.`,
        recommended_actions: ["Check whether a market-signal item for this theme exists but scored below the discovery threshold."],
        evidence: { themeId: theme.id, surfaces: [...surfaces].sort(), memberCount: members.length },
      });
    }
    const pivots = Array.isArray(theme.pivots) ? theme.pivots : [];
    const pivot = pivots[0];
    if (pivot && members.length >= 3 && !surfaces.has("operations")) {
      gaps.push({
        type: "pivot_operations_gap", category: "coverage_gap", subject_type: "system", subject_ref: buildSubjectRef(theme.id),
        description: `Theme ${theme.id}'s pivot (${pivot.id}, centrality ${pivot.centrality}) has no operations-surface counterpart among ${members.length} members.`,
        recommended_actions: ["Review whether this theme has an operational impact that isn't yet captured as an operations-surface item."],
        evidence: { themeId: theme.id, pivotId: pivot.id, pivotCentrality: pivot.centrality, surfaces: [...surfaces].sort(), memberCount: members.length },
      });
    }
  }
  gaps.sort((x, y) => (x.subject_ref !== y.subject_ref ? (x.subject_ref < y.subject_ref ? -1 : 1) : x.type < y.type ? -1 : x.type > y.type ? 1 : 0));
  return gaps;
}

/** The gaps as findings (flag rows, still unwritten). */
export const gapFindings = (gaps: readonly Gap[]): Finding[] =>
  gaps.map((g) => ({ subjectRef: g.subject_ref, row: { category: g.category, subject_type: g.subject_type, subject_ref: g.subject_ref, description: g.description, recommended_actions: g.recommended_actions, created_by: createdBy(GAP_NAMESPACE, g.type) } }));

export interface ForwardEventRow {
  id: string;
  intelligence_item_id: string;
  event_date: string;
  date_precision: string;
  event_kind: string;
  obligation_text: string;
  source_span?: string | null;
  confidence?: string | null;
}
export interface AnticipatedTarget {
  event_id: string;
  subject_ref: string;
  intelligence_item_id: string;
  event_date: string;
  date_precision: string;
  event_kind: string;
  obligation_text: string;
  source_span: string | null;
  confidence: string | null;
  topics: string[];
  instrument_key: string | null;
  other_coverage_count: number;
  reason: "no_coverage" | "thin_coverage";
  description: string;
}

const toMs = (v: unknown): number => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));

/** Future forward events whose topic has no (or one) other covering item: coverage we should expect to need. Never guesses a topic. The clock is injected. */
export function computeAnticipatedTargets(forwardEvents: readonly ForwardEventRow[], corpusIndex: { itemTopics?: Record<string, string[]>; itemInstrumentKeys?: Record<string, string> } = {}, opts: { now: Date | string | number; thinThreshold?: number }): AnticipatedTarget[] {
  const { itemTopics, itemInstrumentKeys } = corpusIndex;
  const nowMs = toMs(opts.now);
  const thin = typeof opts.thinThreshold === "number" && opts.thinThreshold >= 0 ? opts.thinThreshold : 1;
  const topicIndex = new Map<string, Set<string>>();
  for (const [itemId, topics] of Object.entries(itemTopics ?? {})) {
    for (const raw of Array.isArray(topics) ? topics : []) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const t = lc(raw);
      topicIndex.set(t, (topicIndex.get(t) ?? new Set()).add(itemId));
    }
  }
  const targets: AnticipatedTarget[] = [];
  for (const ev of forwardEvents) {
    if (!ev || typeof ev.id !== "string" || typeof ev.intelligence_item_id !== "string" || !ev.event_date) continue;
    const evMs = toMs(ev.event_date);
    if (!Number.isFinite(evMs) || evMs <= nowMs) continue;
    const topics = [...new Set((itemTopics?.[ev.intelligence_item_id] ?? []).filter((x) => typeof x === "string" && x.trim()).map(lc))].sort();
    if (!topics.length) continue;
    const others = new Set<string>();
    for (const t of topics) for (const id of topicIndex.get(t) ?? []) if (id !== ev.intelligence_item_id) others.add(id);
    if (others.size > thin) continue;
    const reason = others.size === 0 ? "no_coverage" : "thin_coverage";
    const key = itemInstrumentKeys?.[ev.intelligence_item_id];
    const instrumentKey = typeof key === "string" && key.trim() ? key.trim() : null;
    targets.push({
      event_id: ev.id, subject_ref: buildSubjectRef(ev.id), intelligence_item_id: ev.intelligence_item_id, event_date: ev.event_date, date_precision: ev.date_precision, event_kind: ev.event_kind,
      obligation_text: ev.obligation_text, source_span: ev.source_span ?? null, confidence: ev.confidence ?? null, topics, instrument_key: instrumentKey, other_coverage_count: others.size, reason,
      description: `Item ${ev.intelligence_item_id}${instrumentKey ? ` (${instrumentKey})` : ""} names a future ${ev.event_kind} obligation on ${ev.event_date} (${ev.date_precision} precision): "${ev.obligation_text}". ${others.size} other corpus item(s) share its topic(s) [${topics.join(", ")}] — ${reason === "no_coverage" ? "no other coverage exists for this topic." : "coverage on this topic is thin."}`,
    });
  }
  targets.sort((x, y) => (x.event_id < y.event_id ? -1 : x.event_id > y.event_id ? 1 : 0));
  return targets;
}

/** The anticipated targets as findings. */
export const anticipateFindings = (targets: readonly AnticipatedTarget[]): Finding[] =>
  targets.map((t) => ({
    subjectRef: t.subject_ref,
    row: { category: "coverage_gap", subject_type: "system", subject_ref: t.subject_ref, description: t.description, recommended_actions: [{ action: "reflected_in_coverage_view", rationale: "anticipated coverage gap, surfaced for visibility; not an operator decision queue (ADR-030 rider, D17 family 13)" }], created_by: createdBy(ANTICIPATE_NAMESPACE, t.reason) },
  }));
