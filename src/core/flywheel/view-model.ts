// Ported from old_repo/src/lib/connections/connection-view-model.mjs (lines 1-235)
// Ported from old_repo/src/lib/connections/brief-candidates.mjs (lines 1-206)
// Ported from old_repo/src/lib/connections/resource-lookup.ts (lines 1-68)
// What the surfaces and the brief author read of the connection graph: connection rows with surface-routed links (the path, label and order tables
// are the routing module's, not a copy), supersession rows, the cross-page intersection view, the lookup of verified linked items, and the candidate
// block handed to a brief author. Relationship vocabulary and specificity come from edges.ts (one table, drift-checked against the CHECK).
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import { isUuid } from "@/core/http/parse";
import { SURFACE_LABELS, SURFACE_ORDER, surfaceHref } from "@/core/routing";
import { joinLabels, labelForComplianceObject, labelForScenario } from "@/core/tags/vocabulary";

import type { BasisEntry } from "./discover";
import { RELATIONSHIP_LABEL } from "./edges";
import { isIntersectionEntry, type IntersectionDetail } from "./intersections";

export interface ResourceRef {
  id: string;
  title: string;
  priority: string;
}
export type ResourceLookup = Record<string, ResourceRef>;
export interface ConnectionIn {
  id: string;
  relationship?: string;
  direction?: "outgoing" | "incoming";
  surface?: string;
  origin?: string;
  basis?: BasisEntry[] | null;
  score?: number | null;
}
export interface ConnectionRow {
  id: string;
  title: string;
  priority: string | null;
  label: string;
  surface: string;
  href: string | null;
  origin: string;
  discovered: boolean;
  basisSummary: { signal: string; weight?: number }[];
  score: number | null;
}

/** "Supersedes", "Implements"...; a generic edge reads by direction (References, Referenced by). */
function labelForConnection(relationship: string | undefined, direction: string | undefined): string {
  return (relationship ? RELATIONSHIP_LABEL[relationship] : undefined) ?? (direction === "outgoing" ? "References" : "Referenced by");
}

export function buildConnectionRows(connections: readonly ConnectionIn[] | null | undefined, lookup: ResourceLookup | null | undefined): ConnectionRow[] {
  const seen = new Set<string>();
  const rows: ConnectionRow[] = [];
  for (const c of connections ?? []) {
    const ref = lookup?.[c?.id];
    if (!c || !c.id || seen.has(c.id) || !ref) continue;
    seen.add(c.id);
    const origin = c.origin || "manual";
    const basis = Array.isArray(c.basis) ? c.basis : [];
    const surface = c.surface || "uncategorized";
    rows.push({ id: c.id, title: ref.title, priority: ref.priority, label: labelForConnection(c.relationship, c.direction), surface, href: surfaceHref(surface, c.id), origin, discovered: origin === "provenance_discovery" && basis.length > 0, basisSummary: basis.slice(0, 3).map((b) => ({ signal: b.signal, ...(b.weight !== undefined ? { weight: b.weight } : {}) })), score: typeof c.score === "number" ? c.score : null });
  }
  rows.sort((a, b) => (a.discovered !== b.discovered ? (a.discovered ? -1 : 1) : a.discovered && b.discovered ? (b.score ?? 0) - (a.score ?? 0) : 0));
  return rows;
}

export interface Supersession {
  old: string;
  new: string;
  oldTitle?: string;
  newTitle?: string;
}
/** Superseded-by / Supersedes rows for one item, always on the Regulations surface (supersession is a regulatory fact). */
export function buildSupersessionRows(supersessions: readonly Supersession[] | null | undefined, selfId: string, lookup: ResourceLookup | null | undefined): ConnectionRow[] {
  const seen = new Set<string>();
  const rows: ConnectionRow[] = [];
  const add = (id: string, fallbackTitle: string | undefined, label: string) => {
    const ref = lookup?.[id];
    rows.push({ id, title: ref?.title || fallbackTitle || id, priority: ref?.priority ?? "MODERATE", label, surface: "regulations", href: surfaceHref("regulations", id), origin: "manual", discovered: false, basisSummary: [], score: null });
    seen.add(id);
  };
  for (const s of supersessions ?? []) {
    if (!s) continue;
    if (s.old === selfId && s.new && !seen.has(s.new)) add(s.new, s.newTitle, "Superseded by");
    else if (s.new === selfId && s.old && !seen.has(s.old)) add(s.old, s.oldTitle, "Supersedes");
  }
  return rows;
}

/** "Connected through the operational scenarios a and b, and the compliance object c." */
function couplingText(detail: IntersectionDetail | undefined): string {
  const scn = (detail?.scenarios ?? []).map(labelForScenario).filter(Boolean);
  const obj = (detail?.objects ?? []).map(labelForComplianceObject).filter(Boolean);
  if (!scn.length && !obj.length) return "";
  const parts: string[] = [];
  if (scn.length) parts.push(`the operational ${scn.length === 1 ? "scenario" : "scenarios"} ${joinLabels(scn)}`);
  if (obj.length) parts.push(`the compliance ${obj.length === 1 ? "object" : "objects"} ${joinLabels(obj)}`);
  return `Connected through ${parts.join(", and ")}.`;
}

export interface IntersectionGroup {
  surface: string;
  label: string;
  samePage: boolean;
  items: { id: string; title: string; href: string; coupling: string }[];
}
/** The cross-page section: items connected through a shared scenario AND compliance object, grouped by surface (other surfaces first), weak ones as "possible". */
export function buildIntersectionView(connections: readonly ConnectionIn[] | null | undefined, lookup: ResourceLookup | null | undefined, opts: { currentSurface?: string; summary?: string | null } = {}): { summary: string | null; groups: IntersectionGroup[]; possible: IntersectionGroup[]; possibleCount: number } | null {
  const best = new Map<string, { detail: IntersectionDetail; strength: number; surface: string }>();
  for (const c of connections ?? []) {
    if (!c || !c.id || !lookup?.[c.id] || !c.surface || !SURFACE_LABELS[c.surface]) continue;
    for (const b of Array.isArray(c.basis) ? c.basis : []) {
      if (!isIntersectionEntry(b) || !b.detail || typeof b.detail !== "object") continue;
      const strength = Number.isFinite(b.detail.strength) ? (b.detail.strength as number) : 0;
      const prior = best.get(c.id);
      if (!prior || strength > prior.strength) best.set(c.id, { detail: b.detail, strength, surface: c.surface });
    }
  }
  const strongOrMedium: (IntersectionGroup["items"][number] & { strength: number; surface: string })[] = [];
  const weak: typeof strongOrMedium = [];
  for (const [id, e] of best) {
    const row = { id, title: (lookup as ResourceLookup)[id]?.title ?? id, href: `/${e.surface}/${encodeURIComponent(id)}`, coupling: couplingText(e.detail), strength: e.strength, surface: e.surface };
    (e.detail.tier === "weak" ? weak : strongOrMedium).push(row);
  }
  const current = opts.currentSurface;
  const group = (rows: typeof strongOrMedium): IntersectionGroup[] => {
    const bySurface = new Map<string, typeof strongOrMedium>();
    for (const r of rows) bySurface.set(r.surface, [...(bySurface.get(r.surface) ?? []), r]);
    const order = [...SURFACE_ORDER.filter((s) => s !== current), ...SURFACE_ORDER.filter((s) => s === current)];
    return order.filter((s) => bySurface.has(s)).map((s) => ({
      surface: s, label: SURFACE_LABELS[s] as string, samePage: s === current,
      items: (bySurface.get(s) ?? []).sort((a, b) => b.strength - a.strength || a.title.localeCompare(b.title)).map(({ id, title, href, coupling }) => ({ id, title, href, coupling })),
    }));
  };
  const stated = typeof opts.summary === "string" && opts.summary.trim() ? opts.summary.trim() : null;
  const groups = group(strongOrMedium);
  const possible = group(weak);
  return !stated && !groups.length && !possible.length ? null : { summary: stated, groups, possible, possibleCount: weak.length };
}

/**
 * Verified live items by id (a uuid or a legacy id) for rendering connection rows; keyed by the UI id (legacy id when there is one). A failed read
 * throws: a row is never rendered with a bare id because a read failed, and never silently dropped either.
 */
export async function buildResourceLookup(sb: Db, relatedIds: readonly string[]): Promise<ResourceLookup> {
  const ids = [...new Set(relatedIds)].filter(Boolean);
  const lookup: ResourceLookup = {};
  const read = async (column: "id" | "legacy_id", list: string[]) => {
    const rows = await fetchAllByIdChunks<{ id: string; legacy_id: string | null; title: string; priority: string }>(list, async (slice) => {
      const { data, error } = await sb.from("intelligence_items").select("id, legacy_id, title, priority").eq("is_archived", false).eq("provenance_status", "verified").in(column, slice);
      if (error) throw new Error(`resource lookup failed: ${error.message}`);
      return data ?? [];
    }, { manyPerId: true });
    for (const row of rows) {
      const uiId = row.legacy_id || row.id;
      lookup[uiId] = { id: uiId, title: row.title, priority: row.priority };
    }
  };
  const uuids = ids.filter((id) => isUuid(id));
  const legacy = ids.filter((id) => !isUuid(id));
  if (legacy.length) await read("legacy_id", legacy);
  if (uuids.length) await read("id", uuids);
  return lookup;
}

// -- the brief author's candidate block ------------------------------------------------------------------------------------------------------------

export interface Candidate {
  id: string;
  relationship: string;
  basis: BasisEntry[];
  score: number | null;
  sources: string[];
}
export interface Selection {
  candidates: Candidate[];
  theme: { id: string; memberCount: number; title: string | null; stale: boolean | null; dominantSignals: { signal: string }[] } | null;
}


