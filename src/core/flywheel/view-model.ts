// Ported from old_repo/src/lib/connections/connection-view-model.mjs (lines 1-235)
// Ported from old_repo/src/lib/connections/brief-candidates.mjs (lines 1-206)
// Ported from old_repo/src/lib/connections/resource-lookup.ts (lines 1-68)
// What the surfaces and the brief author read of the connection graph: connection rows with surface-routed links (the path, label and order tables
// are the routing module's, not a copy), supersession rows, the cross-page intersection view, the lookup of verified linked items, and the candidate
// block handed to a brief author. Relationship vocabulary and specificity come from edges.ts (one table, drift-checked against the CHECK).
import type { Db } from "@/core/db";
import { admitItems } from "@/core/derived/admissible";
import { fetchAllByIdChunks } from "@/core/db";
import { isUuid } from "@/core/http/parse";
import { SURFACE_LABELS, SURFACE_ORDER, surfaceHref } from "@/core/routing";
import { joinLabels, labelForComplianceObject, labelForScenario } from "@/core/tags/vocabulary";
import { asBasis, familyWords, reasonFor } from "@/features/flywheel/radar/read";

import { CANDIDATE_ORIGIN, type EdgeBasis } from "./discover";
import { DISCOVERY_ORIGIN, RELATIONSHIP_LABEL } from "./edges";
import type { FactLink } from "./facts-join";
import { isIntersectionEntry, type IntersectionDetail } from "./intersections";

// -- the causal sentence of a connection, composed from the typed basis (discover.ts EdgeBasis) and the typed facts (facts-join.ts FactLink) ----------------------------------------------
// UI-RADAR-1. A field a stored row does not hold is absent here: the sentence is composed from what the row holds, never from a guess. Rows written before the typed tokens carry a `detail` string, read as the fallback.
export type FactsByItem = ReadonlyMap<string, readonly FactLink[]>;

export interface ResourceRef {
  id: string;
  title: string;
  priority: string;
}
export type ResourceLookup = Record<string, ResourceRef>;
export interface ConnectionIn {
  id: string;
  /** intelligence_items.id when the loader holds it (the key of the facts join). */
  uuid?: string;
  relationship?: string;
  direction?: "outgoing" | "incoming";
  surface?: string;
  origin?: string;
  basis?: EdgeBasis | null | undefined;
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
  /** One plain sentence: why the two are connected. Never empty. */
  reason: string;
  /** A candidate edge: the chain is forming and the next link to watch. Such a row is drawn under "Developing", not in the connection list. */
  developing?: { family: string | null; next: string | null };
}

/** "Supersedes", "Implements"...; a generic edge reads by direction (References, Referenced by). */
function labelForConnection(relationship: string | undefined, direction: string | undefined): string {
  return (relationship ? RELATIONSHIP_LABEL[relationship] : undefined) ?? (direction === "outgoing" ? "References" : "Referenced by");
}

export function buildConnectionRows(connections: readonly ConnectionIn[] | null | undefined, lookup: ResourceLookup | null | undefined, ctx: { self?: readonly FactLink[]; facts?: FactsByItem } = {}): ConnectionRow[] {
  const seen = new Set<string>();
  const rows: ConnectionRow[] = [];
  for (const c of [...(connections ?? [])].sort((a, b) => (b?.score ?? 0) - (a?.score ?? 0))) {
    const ref = lookup?.[c?.id];
    if (!c || !c.id || seen.has(c.id) || !ref) continue;
    const origin = c.origin || "manual";
    const label = labelForConnection(c.relationship, c.direction);
    const basis = asBasis(c.basis);
    const reason = reasonFor({ basis: c.basis, origin, label }, { self: ctx.self ?? [], other: ctx.facts?.get(c.uuid ?? c.id) ?? [] });
    if (!reason && origin !== CANDIDATE_ORIGIN) continue;
    seen.add(c.id);
    const surface = c.surface || "uncategorized";
    rows.push({ id: c.id, title: ref.title, priority: ref.priority, label, surface, href: surfaceHref(surface, c.id), origin, discovered: origin === DISCOVERY_ORIGIN && basis.evidence.length > 0, reason: reason ?? "A chain is forming between the two.", ...(origin === CANDIDATE_ORIGIN ? { developing: { family: familyWords(basis.missing?.patternFamily), next: basis.missing?.truth?.trim() || null } } : {}) });
  }
  return rows.sort((a, b) => Number(!!a.developing) - Number(!!b.developing) || Number(b.discovered) - Number(a.discovered));
}

export interface Supersession {
  old: string;
  new: string;
}
/** Superseded-by / Supersedes rows for one item, always on the Regulations surface (supersession is a regulatory fact). An item the verified lookup does not hold has no row: no title from the raw id, no rating, no link to a page that 404s (F:14). */
export function buildSupersessionRows(supersessions: readonly Supersession[] | null | undefined, selfId: string, lookup: ResourceLookup | null | undefined): ConnectionRow[] {
  const seen = new Set<string>();
  const rows: ConnectionRow[] = [];
  const add = (id: string, label: string) => {
    const ref = lookup?.[id];
    if (!ref) return;
    rows.push({ id, title: ref.title, priority: ref.priority, label, surface: "regulations", href: surfaceHref("regulations", id), origin: "manual", discovered: false, reason: reasonFor({ basis: null, origin: "manual", label }) as string });
    seen.add(id);
  };
  for (const s of supersessions ?? []) {
    if (!s) continue;
    if (s.old === selfId && s.new && !seen.has(s.new)) add(s.new, "Superseded by");
    else if (s.new === selfId && s.old && !seen.has(s.old)) add(s.old, "Supersedes");
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
      const { data, error } = await admitItems(sb.from("intelligence_items").select("id, legacy_id, title, priority")).in(column, slice);
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
