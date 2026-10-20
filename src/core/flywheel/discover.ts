// Ported from old_repo/src/lib/connections/discover.mjs (lines 1-152)
// Ported from old_repo/src/lib/connections/signal-candidates.mjs (lines 91-116)
// Ported from old_repo/src/lib/connections/signal-confidence.mjs (lines 16-36)
// Weighted connection discovery over six bases: shared_source, shared_scenario (inverse-frequency weighted, ADR-019), shared_compliance_object,
// shared_jurisdiction_topic, shared_entity (the old decisive regulation-identifier signal, weight 0.85) and shared_obligation. A connection is
// material at score >= the threshold; at most `perTagCap` tag contributions per basis (the highest weighted); role tags never count.
import { surfaceOf } from "@/core/routing";

import { CONFIG, ROLE_TAGS } from "./config";
import type { Signature } from "./signature";

export interface BasisEntry {
  signal: string;
  detail?: unknown;
  weight?: number;
}
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

/** Score one pair: the basis list, the capped score, the strongest basis as the relationship hint, and whether the two sit on different surfaces. */
function scoreConnection(a: Signature, b: Signature, f?: TagFrequencies): ReturnType<typeof none> {
  if (!a?.id || !b?.id || a.id === b.id) return none();
  const W = CONFIG.weights;
  const cap = CONFIG.perTagCap;
  const basis: BasisEntry[] = [];
  if (a.source_id && b.source_id && a.source_id === b.source_id) basis.push({ signal: "shared_source", detail: "grounded in the same source", weight: W.shared_source });
  const scenarios = overlap(a.operational_scenario_tags, b.operational_scenario_tags)
    .map((t) => ({ t, weight: W.shared_scenario * idf(t, f) }))
    .sort((x, y) => y.weight - x.weight || (x.t < y.t ? -1 : x.t > y.t ? 1 : 0))
    .slice(0, cap);
  for (const { t, weight } of scenarios) basis.push({ signal: "shared_scenario", detail: `both touch ${t}`, weight });
  for (const t of overlap(a.compliance_object_tags, b.compliance_object_tags).filter((x) => !ROLE_TAGS.has(x)).slice(0, cap)) {
    basis.push({ signal: "shared_compliance_object", detail: `both address ${t}`, weight: W.shared_compliance_object });
  }
  const jur = overlap([...arr(a.jurisdictions), ...arr(a.jurisdiction_iso)], [...arr(b.jurisdictions), ...arr(b.jurisdiction_iso)]);
  const topics = overlap(a.topic_tags, b.topic_tags);
  if (jur.length && topics.length) basis.push({ signal: "shared_jurisdiction_topic", detail: `both in ${jur.slice(0, 2).join("/")} on ${topics.slice(0, 2).join("/")}`, weight: W.shared_jurisdiction_topic });
  const sharedEntities = overlap(a.entity_ids, b.entity_ids).slice(0, cap);
  if (sharedEntities.length) basis.push({ signal: "shared_entity", detail: `both name ${sharedEntities.map((e) => (e.startsWith("reg:") ? e.slice(4) : e)).join(", ")}`, weight: W.shared_entity });
  const sharedObligations = overlap(a.obligation_keys, b.obligation_keys).slice(0, cap);
  if (sharedObligations.length) basis.push({ signal: "shared_obligation", detail: `both carry obligation ${sharedObligations[0]}`, weight: W.shared_obligation });
  if (!basis.length) return none();
  const score = Math.min(1, basis.reduce((s, x) => s + (x.weight ?? 0), 0));
  const strongest = basis.slice().sort((x, y) => (y.weight ?? 0) - (x.weight ?? 0))[0] as BasisEntry;
  const sa = surfaceOf(a.item_type, a.domain);
  const sb = surfaceOf(b.item_type, b.domain);
  return { score, basis, crossSurface: sa !== "uncategorized" && sb !== "uncategorized" && sa !== sb, relationship: strongest.signal };
}

/** Material connections of one item against candidates: cross-surface first (the differentiator), then by score; at most `limit`. */
export function discoverConnections(item: Signature, candidates: readonly Signature[], opts: { threshold?: number; limit?: number; freqMap?: TagFrequencies } = {}): Connection[] {
  const threshold = opts.threshold ?? CONFIG.threshold;
  const limit = opts.limit ?? CONFIG.limit;
  const out: Connection[] = [];
  for (const c of candidates) {
    const r = scoreConnection(item, c, opts.freqMap);
    if (r.score >= threshold) out.push({ target: c.id, ...r });
  }
  out.sort((x, y) => (y.crossSurface !== x.crossSurface ? (y.crossSurface ? 1 : -1) : y.score - x.score || (x.target < y.target ? -1 : 1)));
  return out.slice(0, limit);
}
