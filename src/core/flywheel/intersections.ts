// Ported from old_repo/src/lib/connections/intersections.mjs (lines 1-171)
// Cross-surface intersections: a pair on two different customer surfaces that shares both a scenario AND a (non-role) compliance object.
// Strength is a point sum (scenario 3, object 2, explicit edge 5, both high priority 2); tier medium at 8 and strong at 12; the score is a
// piecewise mapping of strength. Written as an appended basis entry that never changes an edge's relationship, origin or score.
import { surfaceOf } from "@/core/routing";

import { CONFIG, ROLE_TAGS } from "./config";
import type { BasisEntry } from "./discover";

export const INTERSECTION_SIGNAL = "intersection";
const { points: POINTS, tierMin: TIER_MIN } = CONFIG.intersection;
const HIGH_PRIORITY = new Set(CONFIG.intersection.highPriority);

export interface IntersectionItem {
  id: string;
  item_type?: string | null;
  domain?: number | null;
  priority?: string | null;
  is_archived?: boolean | null;
  provenance_status?: string | null;
  operational_scenario_tags?: string[] | null;
  compliance_object_tags?: string[] | null;
  related_items?: string[] | null;
}
export interface IntersectionPair {
  a: string;
  b: string;
  shared_scenarios: string[];
  shared_objects: string[];
  strength: number;
  tier: Tier;
  cross_surface: boolean | null;
}
export type Tier = "strong" | "medium" | "weak";
export interface IntersectionDetail {
  scenarios?: string[];
  objects?: string[];
  strength?: number;
  tier?: Tier;
}

const lc = (s: unknown): string => String(s ?? "").toLowerCase().trim();
const tags = (x: unknown): string[] => [...new Set((Array.isArray(x) ? x : []).filter((v): v is string => typeof v === "string" && v.trim() !== "").map(lc))].sort();
const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

export const tierOf = (strength: number): Tier => (strength >= TIER_MIN.strong ? "strong" : strength >= TIER_MIN.medium ? "medium" : "weak");

/** Strength to edge score: weak 0.3..0.5, medium 0.5..0.9, strong 0.9..1. */
export function strengthToScore(strength: number): number {
  const s = Number(strength);
  if (!Number.isFinite(s)) return 0.3;
  const v = s < TIER_MIN.medium ? 0.3 + (Math.max(s, 5) - 5) / 15 : s < TIER_MIN.strong ? 0.5 + (s - TIER_MIN.medium) * 0.1 : 0.9 + (s - TIER_MIN.strong) * 0.025;
  return round4(Math.min(1, v));
}

/** Different surfaces on the routing rule; null when either type is unknown, false when either is uncategorized. */
export function isCrossSurface(a: Pick<IntersectionItem, "item_type" | "domain">, b: Pick<IntersectionItem, "item_type" | "domain">): boolean | null {
  if (!a?.item_type || !b?.item_type) return null;
  const sa = surfaceOf(a.item_type, a.domain);
  const sb = surfaceOf(b.item_type, b.domain);
  return sa === "uncategorized" || sb === "uncategorized" ? false : sa !== sb;
}

export const isIntersectionEntry = (b: unknown): b is BasisEntry & { detail: IntersectionDetail } => !!b && typeof b === "object" && (b as BasisEntry).signal === INTERSECTION_SIGNAL;

export function buildIntersectionEntry(pair: Pick<IntersectionPair, "shared_scenarios" | "shared_objects" | "strength" | "tier">): BasisEntry {
  return { signal: INTERSECTION_SIGNAL, detail: { scenarios: pair.shared_scenarios, objects: pair.shared_objects, strength: pair.strength, tier: pair.tier }, weight: strengthToScore(pair.strength) };
}

interface Live {
  raw: IntersectionItem;
  id: string;
  scenarios: string[];
  objects: string[];
  objectSet: Set<string>;
  related: Set<string>;
  high: boolean;
}

/** Every intersecting pair over the verified live items, strongest first. A scenario index keeps it from being quadratic over the corpus. */
export function detectIntersections(items: readonly IntersectionItem[]): IntersectionPair[] {
  const seen = new Set<string>();
  const live: Live[] = [];
  for (const it of items) {
    if (!it || typeof it.id !== "string" || !it.id || seen.has(it.id) || it.is_archived) continue;
    if (it.provenance_status !== undefined && it.provenance_status !== null && it.provenance_status !== "verified") continue;
    seen.add(it.id);
    const objects = tags(it.compliance_object_tags).filter((t) => !ROLE_TAGS.has(t));
    live.push({ raw: it, id: it.id, scenarios: tags(it.operational_scenario_tags), objects, objectSet: new Set(objects), related: new Set(Array.isArray(it.related_items) ? it.related_items : []), high: HIGH_PRIORITY.has(String(it.priority ?? "").toUpperCase()) });
  }
  live.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const index = new Map<string, number[]>();
  live.forEach((it, pos) => {
    if (!it.objects.length) return;
    for (const t of it.scenarios) index.set(t, [...(index.get(t) ?? []), pos]);
  });
  const out: IntersectionPair[] = [];
  for (let i = 0; i < live.length; i += 1) {
    const A = live[i] as Live;
    if (!A.objects.length) continue;
    const cand = new Map<number, string[]>();
    for (const t of A.scenarios) for (const j of index.get(t) ?? []) if (j > i) cand.set(j, [...(cand.get(j) ?? []), t]);
    for (const [j, scn] of cand) {
      const B = live[j] as Live;
      const objs = A.objects.filter((o) => B.objectSet.has(o));
      if (!objs.length) continue;
      const strength = POINTS.scenario * scn.length + POINTS.object * objs.length + (A.related.has(B.id) || B.related.has(A.id) ? POINTS.explicit : 0) + (A.high && B.high ? POINTS.priority : 0);
      out.push({ a: A.id, b: B.id, shared_scenarios: scn.slice().sort(), shared_objects: objs, strength, tier: tierOf(strength), cross_surface: isCrossSurface(A.raw, B.raw) });
    }
  }
  out.sort((x, y) => y.strength - x.strength || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) || (x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  return out;
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** The identity of a basis entry: its signal and its canonicalised detail. */
export function basisEntryKey(b: BasisEntry | null | undefined): string {
  const d = b?.detail;
  return `${b?.signal ?? ""}|${typeof d === "string" ? d : d == null ? "" : canonicalJson(d)}`;
}

/** A basis entry's detail as one line of text. */
export function basisDetailText(b: BasisEntry | null | undefined): string {
  const d = b?.detail;
  if (d == null || d === "") return "";
  if (typeof d === "string") return d;
  if (isIntersectionEntry(b)) {
    const list = (x: unknown) => (Array.isArray(x) ? x.join(", ") : "");
    return `scenarios: ${list(b.detail.scenarios)}; objects: ${list(b.detail.objects)}; ${b.detail.tier ?? "weak"} tier, strength ${b.detail.strength ?? 0}`;
  }
  return canonicalJson(d);
}
