// Ported from old_repo/src/lib/connections/discover.mjs (lines 1-152)
// Ported from old_repo/src/lib/connections/signal-candidates.mjs (lines 91-116)
// Ported from old_repo/src/lib/connections/signal-confidence.mjs (lines 16-36)
// Weighted connection discovery over seven evidence kinds: shared_source (corroboration only: it never connects on its own), shared_scenario (inverse-frequency weighted, ADR-019), shared_compliance_object, shared_jurisdiction_topic, shared_entity (two items filed
// under one specific entity, weight 0.85), coupled_entity (their entities meet across one entity_relations edge, ENGINE-JOIN-1) and shared_obligation. A connection is material at score >= the threshold; a pair that falls short but holds entity evidence, or
// scores at least the candidate floor, is a developing connection (kept, never shown as a connection). At most `perTagCap` tag contributions per kind (the highest weighted); role tags never count. Every evidence entry carries the typed tokens that produced it.
import { surfaceOf } from "@/core/routing";

import { CONFIG, ROLE_TAGS } from "./config";
import type { Missing } from "./facts-join";
import type { HopRef, Signature } from "./signature";

export interface EntityToken {
  id: string;
  name: string | null;
}
/** The typed tokens behind one evidence entry, so a surface can compose its reason without re-deriving anything. */
export interface EvidenceTokens {
  entities?: EntityToken[];
  /** coupled_entity: the relation row (parent, relation token, child) the two items' entities meet across. */
  coupled?: { parent: EntityToken; relation: string; child: EntityToken }[];
  obligations?: string[];
  scenarios?: string[];
  objects?: string[];
  jurisdictions?: string[];
  topics?: string[];
}
export interface BasisEntry {
  signal: string;
  detail?: unknown;
  weight?: number;
  tokens?: EvidenceTokens;
}
/** What item_cross_references.basis holds. A discovery edge: the evidence list. Any edge may be the object form, which also carries what a candidate lacks (`missing`) and a reader's causal text (`rationale`, authored later by a drain lane, never by code, ADR-050). Existing rows are the list. */
export type EdgeBasis = BasisEntry[] | { evidence: BasisEntry[]; missing?: Missing | null; rationale?: { text: string; authoredBy: string; at: string } };
export interface Connection {
  target: string;
  score: number;
  basis: BasisEntry[];
  crossSurface: boolean;
  relationship: string;
}
export interface TagFrequencies {
  freq: Map<string, number>;
  refFreq: number;
}

/** The origin of a developing connection in item_cross_references: kept, never shown as a connection (migration 0145). */
export const CANDIDATE_ORIGIN = "candidate";
const CORROBORATION = "shared_source";
const ENTITY_KINDS: readonly string[] = ["shared_entity", "coupled_entity"];

/** The evidence list of a stored basis, whatever its form (list, object, or nothing). */
export const evidenceOf = (basis: unknown): BasisEntry[] => {
  const list = Array.isArray(basis) ? basis : basis && typeof basis === "object" && Array.isArray((basis as { evidence?: unknown }).evidence) ? (basis as { evidence: unknown[] }).evidence : [];
  return list.filter((b): b is BasisEntry => !!b && typeof b === "object" && typeof (b as BasisEntry).signal === "string");
};
/** The basis for a rewritten evidence list: the list, unless the prior basis carried a reader's rationale, which a refresh keeps. */
export const basisWith = (prior: unknown, evidence: BasisEntry[]): EdgeBasis => {
  const rationale = prior && typeof prior === "object" && !Array.isArray(prior) ? (prior as { rationale?: unknown }).rationale : undefined;
  return rationale ? { evidence, rationale: rationale as { text: string; authoredBy: string; at: string } } : evidence;
};
/** A basis whose only evidence is a shared source: it corroborates and connects nothing. An edge with no evidence at all (a manual link) is not corroboration-only. */
export const isCorroborationOnly = (basis: unknown): boolean => {
  const e = evidenceOf(basis);
  return e.length > 0 && e.every((b) => b.signal === CORROBORATION);
};

const arr = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && v.trim() !== "") : []);
const lc = (s: unknown): string => String(s ?? "").toLowerCase().trim();
const overlap = (a: unknown, b: unknown): string[] => {
  const B = new Set(arr(b).map(lc));
  return [...new Set(arr(a).map(lc))].filter((x) => B.has(x));
};
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Inverse-frequency weight of a scenario tag: 1 for a rare tag, down to 0.25 for a tag far more common than the median shared tag. */
function idf(tag: string, f: TagFrequencies | undefined): number {
  if (!f || !f.refFreq) return 1;
  const freq = f.freq.get(tag) || 1;
  return clamp(1 - 0.25 * Math.log2(Math.max(1, freq) / f.refFreq), 0.25, 1);
}

/** Per scenario tag, how many corpus items carry it; the reference frequency is the median over tags seen at least twice. */
export function computeTagFrequencies(corpus: readonly Pick<Signature, "operational_scenario_tags">[]): TagFrequencies {
  const freq = new Map<string, number>();
  for (const item of corpus) for (const t of new Set(arr(item?.operational_scenario_tags).map(lc))) freq.set(t, (freq.get(t) || 0) + 1);
  const eligible = [...freq.values()].filter((n) => n >= 2).sort((x, y) => x - y);
  let refFreq = 0;
  if (eligible.length) {
    const mid = Math.floor(eligible.length / 2);
    refFreq = eligible.length % 2 === 1 ? (eligible[mid] as number) : ((eligible[mid - 1] as number) + (eligible[mid] as number)) / 2;
  }
  return { freq, refFreq };
}

const none = (): { score: number; basis: BasisEntry[]; crossSurface: boolean; relationship: string } => ({ score: 0, basis: [], crossSurface: false, relationship: "none" });
const nameOf = (a: Signature, b: Signature, id: string): EntityToken => ({ id, name: a.entity_names?.get(id) ?? b.entity_names?.get(id) ?? null });
const label = (t: EntityToken): string => t.name ?? (t.id.startsWith("reg:") ? t.id.slice(4) : t.id);

/** The relation rows through which the direct entities of `a` meet those of `b`, each as (parent, relation, child). */
function couplings(a: Signature, b: Signature, bIds: ReadonlySet<string>): { parent: string; relation: string; child: string }[] {
  const out = new Map<string, { parent: string; relation: string; child: string }>();
  const meet = (hops: readonly HopRef[] | undefined, own: ReadonlySet<string>) => {
    for (const h of hops ?? []) {
      if (!own.has(h.entity_id)) continue;
      const [parent, child] = h.via_is_parent ? [h.via, h.entity_id] : [h.entity_id, h.via];
      out.set(`${parent}|${h.relation}|${child}`, { parent, relation: h.relation, child });
    }
  };
  meet(a.hops, bIds);
  meet(b.hops, new Set(a.entity_ids ?? []));
  return [...out.values()].sort((x, y) => (`${x.parent}|${x.relation}|${x.child}` < `${y.parent}|${y.relation}|${y.child}` ? -1 : 1));
}

/** Score one pair: the evidence list, the capped score, the strongest kind as the relationship hint, and whether the two sit on different surfaces. */
function scoreConnection(a: Signature, b: Signature, f?: TagFrequencies): ReturnType<typeof none> {
  if (!a?.id || !b?.id || a.id === b.id) return none();
  const W = CONFIG.weights;
  const cap = CONFIG.perTagCap;
  const basis: BasisEntry[] = [];
  if (a.source_id && b.source_id && a.source_id === b.source_id) basis.push({ signal: CORROBORATION, detail: "grounded in the same source", weight: W.shared_source });
  const scenarios = overlap(a.operational_scenario_tags, b.operational_scenario_tags)
    .map((t) => ({ t, weight: W.shared_scenario * idf(t, f) }))
    .sort((x, y) => y.weight - x.weight || (x.t < y.t ? -1 : x.t > y.t ? 1 : 0))
    .slice(0, cap);
  for (const { t, weight } of scenarios) basis.push({ signal: "shared_scenario", detail: `both touch ${t}`, weight, tokens: { scenarios: [t] } });
  for (const t of overlap(a.compliance_object_tags, b.compliance_object_tags).filter((x) => !ROLE_TAGS.has(x)).slice(0, cap)) {
    basis.push({ signal: "shared_compliance_object", detail: `both address ${t}`, weight: W.shared_compliance_object, tokens: { objects: [t] } });
  }
  const jur = overlap([...arr(a.jurisdictions), ...arr(a.jurisdiction_iso)], [...arr(b.jurisdictions), ...arr(b.jurisdiction_iso)]);
  const topics = overlap(a.topic_tags, b.topic_tags);
  if (jur.length && topics.length) basis.push({ signal: "shared_jurisdiction_topic", detail: `both in ${jur.slice(0, 2).join("/")} on ${topics.slice(0, 2).join("/")}`, weight: W.shared_jurisdiction_topic, tokens: { jurisdictions: jur.slice(0, 2), topics: topics.slice(0, 2) } });
  const shared = overlap(a.entity_ids, b.entity_ids).slice(0, cap);
  if (shared.length) {
    const entities = shared.map((id) => nameOf(a, b, id));
    basis.push({ signal: "shared_entity", detail: `both name ${entities.map(label).join(", ")}`, weight: W.shared_entity, tokens: { entities } });
  }
  const coupled = couplings(a, b, new Set(b.entity_ids ?? [])).slice(0, cap);
  if (coupled.length) {
    const tokens = coupled.map((c) => ({ parent: nameOf(a, b, c.parent), relation: c.relation, child: nameOf(a, b, c.child) }));
    basis.push({ signal: "coupled_entity", detail: tokens.map((c) => `${label(c.parent)} ${c.relation} ${label(c.child)}`).join(", "), weight: W.coupled_entity, tokens: { coupled: tokens } });
  }
  const obligations = overlap(a.obligation_keys, b.obligation_keys).slice(0, cap);
  if (obligations.length) basis.push({ signal: "shared_obligation", detail: `both carry obligation ${obligations[0]}`, weight: W.shared_obligation, tokens: { obligations } });
  if (!basis.length) return none();
  const score = Math.min(1, basis.reduce((s, x) => s + (x.weight ?? 0), 0));
  const strongest = basis.slice().sort((x, y) => (y.weight ?? 0) - (x.weight ?? 0))[0] as BasisEntry;
  const sa = surfaceOf(a.item_type, a.domain);
  const sb = surfaceOf(b.item_type, b.domain);
  return { score, basis, crossSurface: sa !== "uncategorized" && sb !== "uncategorized" && sa !== sb, relationship: strongest.signal };
}

const byRank = (x: Connection, y: Connection): number => (y.crossSurface !== x.crossSurface ? (y.crossSurface ? 1 : -1) : y.score - x.score || (x.target < y.target ? -1 : 1));

/**
 * One item against candidates: the material connections (cross-surface first, then by score; at most `limit`) and the developing ones (below the threshold but holding entity evidence or at least the candidate floor; strongest first, at most the candidate cap).
 * A pair whose only evidence is a shared source is neither: it corroborates and connects nothing.
 */
export function discoverAll(item: Signature, candidates: readonly Signature[], opts: { threshold?: number; limit?: number; freqMap?: TagFrequencies } = {}): { kept: Connection[]; developing: Connection[] } {
  const threshold = opts.threshold ?? CONFIG.threshold;
  const limit = opts.limit ?? CONFIG.limit;
  const kept: Connection[] = [];
  const developing: Connection[] = [];
  for (const c of candidates) {
    const r = scoreConnection(item, c, opts.freqMap);
    if (!r.basis.length || r.basis.every((b) => b.signal === CORROBORATION)) continue;
    if (r.score >= threshold) kept.push({ target: c.id, ...r });
    else if (r.score >= CONFIG.candidate.floor || r.basis.some((b) => ENTITY_KINDS.includes(b.signal))) developing.push({ target: c.id, ...r });
  }
  kept.sort(byRank);
  developing.sort((x, y) => y.score - x.score || (x.target < y.target ? -1 : 1));
  return { kept: kept.slice(0, limit), developing: developing.slice(0, CONFIG.candidate.cap) };
}
