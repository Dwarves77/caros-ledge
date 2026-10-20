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

import type { BasisEntry } from "./discover";
import { RELATIONSHIP_LABEL, relationshipSpecificity, THEME_MEMBERSHIP } from "./edges";
import { basisDetailText, basisEntryKey, isIntersectionEntry, type IntersectionDetail } from "./intersections";
import { isBriefStale } from "./themes";

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
export function labelForConnection(relationship: string | undefined, direction: string | undefined): string {
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
}
/** Superseded-by / Supersedes rows for one item, always on the Regulations surface (supersession is a regulatory fact). An item the verified lookup does not hold has no row: no title from the raw id, no rating, no link to a page that 404s (F:14). */
export function buildSupersessionRows(supersessions: readonly Supersession[] | null | undefined, selfId: string, lookup: ResourceLookup | null | undefined): ConnectionRow[] {
  const seen = new Set<string>();
  const rows: ConnectionRow[] = [];
  const add = (id: string, label: string) => {
    const ref = lookup?.[id];
    if (!ref) return;
    rows.push({ id, title: ref.title, priority: ref.priority, label, surface: "regulations", href: surfaceHref("regulations", id), origin: "manual", discovered: false, basisSummary: [], score: null });
    seen.add(id);
  };
  for (const s of supersessions ?? []) {
    if (!s) continue;
    if (s.old === selfId && s.new && !seen.has(s.new)) add(s.new, "Superseded by");
    else if (s.new === selfId && s.old && !seen.has(s.old)) add(s.old, "Supersedes");
  }
  return rows;
}

export const buildAllConnectionRows = (supersessions: readonly Supersession[] | null | undefined, selfId: string, connections: readonly ConnectionIn[] | null | undefined, lookup: ResourceLookup | null | undefined): ConnectionRow[] => [
  ...buildSupersessionRows(supersessions, selfId, lookup),
  ...buildConnectionRows(connections, lookup),
];

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

// -- the brief author's candidate block ------------------------------------------------------------------------------------------------------------

export const MAX_CANDIDATES = 10;
const isFiniteScore = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
export interface CrossRefRow {
  source_item_id: string;
  target_item_id: string;
  relationship?: string;
  basis?: BasisEntry[] | null;
  score?: number | null;
}
export interface ThemeIn {
  id: string;
  member_ids: readonly string[];
  dominant_signals?: { signal: string }[] | null;
}
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

function readableBasisDetail(b: BasisEntry): string {
  const d = b?.detail as IntersectionDetail | undefined;
  if (isIntersectionEntry(b) && d && typeof d === "object") {
    const list = (xs: unknown, label: (x: string) => string) => (Array.isArray(xs) ? xs.map(label).filter(Boolean).join(", ") : "");
    return `scenarios: ${list(d.scenarios, labelForScenario)}; objects: ${list(d.objects, labelForComplianceObject)}; ${d.tier ?? "weak"} tier, strength ${d.strength ?? 0}`;
  }
  return basisDetailText(b);
}

/** Up to ten connected items for a brief author: cross-reference edges first, then theme co-members, each with its relationship and grounded basis. */
export function selectCandidates(itemId: string, input: { crossRefRows?: readonly CrossRefRow[]; theme?: ThemeIn | null; themeBrief?: { member_hash?: string | null; title?: string | null } | null }): Selection {
  const byId = new Map<string, { id: string; relationships: Set<string>; basis: BasisEntry[]; score: number | null; sources: Set<string> }>();
  const touch = (id: string) => {
    let c = byId.get(id);
    if (!c) byId.set(id, (c = { id, relationships: new Set(), basis: [], score: null, sources: new Set() }));
    return c;
  };
  const mergeBasis = (acc: BasisEntry[], incoming: readonly BasisEntry[] | null | undefined) => {
    for (const b of incoming ?? []) if (b && b.signal && !acc.some((x) => basisEntryKey(x) === basisEntryKey(b))) acc.push(b);
  };
  for (const e of input.crossRefRows ?? []) {
    if (!e || typeof e.source_item_id !== "string" || typeof e.target_item_id !== "string") continue;
    const other = e.source_item_id === itemId ? e.target_item_id : e.target_item_id === itemId ? e.source_item_id : null;
    if (!other || other === itemId) continue;
    const c = touch(other);
    c.sources.add("cross_reference");
    if (e.relationship) c.relationships.add(e.relationship);
    mergeBasis(c.basis, e.basis);
    if (isFiniteScore(e.score)) c.score = c.score == null ? e.score : Math.max(c.score, e.score);
  }
  const { theme, themeBrief } = input;
  let themeContext: Selection["theme"] = null;
  if (theme && Array.isArray(theme.member_ids) && theme.member_ids.includes(itemId)) {
    const dominant = (theme.dominant_signals ?? []).filter((s) => s && s.signal);
    const themeBasis: BasisEntry[] = dominant.length ? dominant.slice(0, 3) : [{ signal: "co-clustered", detail: `member of the same connection theme (id ${theme.id})` }];
    for (const mid of theme.member_ids) {
      if (!mid || mid === itemId) continue;
      const c = touch(mid);
      c.sources.add("connection_theme");
      mergeBasis(c.basis, themeBasis);
    }
    themeContext = { id: theme.id, memberCount: theme.member_ids.length, title: typeof themeBrief?.title === "string" ? themeBrief.title : null, stale: themeBrief && typeof themeBrief.member_hash === "string" ? isBriefStale(themeBrief.member_hash, theme.member_ids) : null, dominantSignals: dominant };
  }
  const pick = (rels: Set<string>): string => (rels.size ? [...rels].sort((a, b) => relationshipSpecificity(a) - relationshipSpecificity(b) || (a < b ? -1 : a > b ? 1 : 0))[0] as string : THEME_MEMBERSHIP);
  const finalized: Candidate[] = [...byId.values()].map((c) => ({
    id: c.id, relationship: pick(c.relationships), score: c.score, sources: [...c.sources].sort(),
    basis: c.basis.slice().sort((x, y) => (y.weight ?? 0) - (x.weight ?? 0) || String(x.signal).localeCompare(String(y.signal)) || basisDetailText(x).localeCompare(basisDetailText(y))),
  }));
  finalized.sort((a, b) => {
    const ta = a.sources.includes("cross_reference") ? 0 : 1;
    const tb = b.sources.includes("cross_reference") ? 0 : 1;
    if (ta !== tb) return ta - tb;
    const as = a.score ?? -1;
    const bs = b.score ?? -1;
    return as !== bs ? bs - as : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { candidates: finalized.slice(0, MAX_CANDIDATES), theme: themeContext };
}

export interface CandidateLoaders {
  loadCrossReferences(itemId: string): Promise<CrossRefRow[]>;
  loadThemeForItem?(itemId: string): Promise<ThemeIn | null>;
  loadThemeBrief?(themeId: string): Promise<{ member_hash?: string | null; title?: string | null } | null>;
}
export async function selectBriefCandidates(itemId: string, deps: CandidateLoaders): Promise<Selection> {
  const crossRefRows = await deps.loadCrossReferences(itemId);
  const theme = deps.loadThemeForItem ? await deps.loadThemeForItem(itemId) : null;
  const themeBrief = theme && deps.loadThemeBrief ? await deps.loadThemeBrief(theme.id) : null;
  return selectCandidates(itemId, { crossRefRows, theme, themeBrief });
}

/** The CANDIDATE CONNECTIONS block for the author's bundle (empty when there are none). The graph's hints, never an obligation to assert a link. */
export function formatCandidateBlock(selection: Selection | null | undefined): string {
  const candidates = selection?.candidates ?? [];
  if (!selection || !candidates.length) return "";
  const lines = candidates.map((c) => {
    const basisTxt = c.basis.length ? c.basis.slice(0, 3).map((b) => (readableBasisDetail(b) ? `${b.signal} (${readableBasisDetail(b)})` : b.signal)).join(", ") : "no basis recorded";
    return `- ${c.id} — relationship: ${c.relationship}${isFiniteScore(c.score) ? ` — score ${c.score.toFixed(2)}` : ""} — basis: ${basisTxt}`;
  });
  const t = selection.theme;
  const themeTxt = t
    ? `\nThis item is a live member of connection theme ${t.id} (${t.memberCount} members${t.title ? `, "${t.title}"` : ""})${t.stale === true ? " — NOTE: the stored theme brief is STALE (membership drifted since it was generated); treat its content as historical context only, never as a current fact to cite" : ""}${t.dominantSignals.length ? `. The theme's dominant shared signals: ${t.dominantSignals.map((s) => s.signal).join(", ")}.` : "."}`
    : "";
  return `\nCANDIDATE CONNECTIONS (graph-derived — the connection graph already identified these items as related to this topic, from real cross-reference edges and/or theme clustering; each carries its relationship and the basis grounding WHY, never invented). Per the A3 assertion rule: you may put a candidate's id into related_items ONLY when your OWN synthesis genuinely evidences the relationship in this brief's content — when you do, cite the reason inline in intersection_summary using the basis below, in your own words, not a bare restatement of the score. A candidate is a hint, not an obligation: most candidates will not belong in most briefs, and omitting all of them is the correct, honest outcome when nothing you actually wrote supports a link. You may still assert a relation to any OTHER item in your source pool that is not listed here — this block does not narrow that.\n${lines.join("\n")}${themeTxt}\n`;
}
