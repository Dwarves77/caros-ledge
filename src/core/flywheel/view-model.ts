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
import { RELATIONS } from "@/core/coupling";
import { PATTERN_METHODS } from "@/core/propagation/methods";
import { PATTERN_COPY } from "@/features/operations/model/derived-view";
import { formatDate } from "@/core/shared";
import { joinLabels, labelForComplianceObject, labelForScenario } from "@/core/tags/vocabulary";

import { RELATIONSHIP_LABEL } from "./edges";
import { isIntersectionEntry, type IntersectionDetail } from "./intersections";

// -- the typed basis and the typed facts a reason is composed from ------------------------------------------------------------------------------
// UI-RADAR-1. `EdgeBasisIn` is structurally compatible with ENGINE-JOIN-1's EdgeBasis (discover.ts) and with the rows stored before it (a list of {signal, detail, weight}); `FactLink` with its facts-join.ts.
// A field absent on an old row is absent here: the sentence is composed from what the row holds, never from a guess.
export interface EdgeEvidence {
  signal: string;
  weight?: number;
  detail?: unknown;
  /** The entities that produced the evidence (canonical names), the relation token that coupled two of them, the scenario or object tokens, and the obligation's duty holder and date. */
  entities?: { id?: string; canonicalName?: string }[];
  relation?: string;
  tokens?: string[];
  dutyHolder?: string;
  date?: string;
}
/** What no pair has yet: the surface that would complete the chain, the fact it would state and the pattern family the pair could form. */
export interface EdgeMissing {
  surface: string;
  truth: string;
  patternFamily?: string;
}
export interface EdgeBasisObject {
  evidence?: EdgeEvidence[];
  missing?: EdgeMissing | null;
  /** Reader-authored causal text (ADR-050): rendered first when present. */
  rationale?: { text?: string } | string | null;
}
export type EdgeBasisIn = EdgeEvidence[] | EdgeBasisObject | null | undefined;

export interface FactSummary {
  title?: string;
  label?: string;
  value?: number | string | null;
  unit?: string | null;
  currency?: string | null;
  asOf?: string | null;
  delta?: { window: "1w" | "1m"; pct: number } | null;
  dutyHolder?: string | null;
  date?: string | null;
  penalty?: string | null;
  trl?: number | null;
  abatementCost?: string | null;
}
export interface FactLink {
  refTable: string;
  refId: string;
  entity: { id: string; kind: string; canonicalName: string };
  relation?: string;
  hop: 0 | 1;
  surface: string;
  summary: FactSummary;
}
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
  basis?: EdgeBasisIn;
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

const asBasis = (b: EdgeBasisIn): { evidence: EdgeEvidence[]; missing: EdgeMissing | null; rationale: string | null } => {
  const o: EdgeBasisObject = Array.isArray(b) ? { evidence: b } : b && typeof b === "object" ? b : {};
  const r = o.rationale;
  const text = typeof r === "string" ? r : r?.text;
  return { evidence: (o.evidence ?? []).filter((e) => e && typeof e.signal === "string"), missing: o.missing ?? null, rationale: text?.trim() || null };
};

// the evidence kinds, strongest first; a signal is one of these under either spelling (the stored "shared_scenario" or the typed "scenario")
const KIND_ORDER = ["entity", "coupled", "obligation", "intersection", "scenario", "object", "jurisdiction"] as const;
type EvidenceKind = (typeof KIND_ORDER)[number] | "source";
const KIND_OF_SIGNAL: Readonly<Record<string, EvidenceKind>> = { shared_entity: "entity", entity: "entity", coupled_entity: "coupled", shared_obligation: "obligation", obligation: "obligation", intersection: "intersection", shared_scenario: "scenario", scenario: "scenario", shared_compliance_object: "object", compliance_object: "object", shared_jurisdiction_topic: "jurisdiction", jurisdiction_topic: "jurisdiction", jurisdiction: "jurisdiction", shared_source: "source", source: "source" };
/** A relation token in words, for "{A} {relation} {B}" (the closed RELATIONS of the coupling ontology). */
const RELATION_WORDS: Readonly<Record<(typeof RELATIONS)[number], string>> = { feedstock_of: "is a feedstock of", fuel_for_mode: "fuels", competes_for_feedstock: "competes for feedstock with", shares_grid_zone: "shares a grid zone with", serves_hub: "serves", corridor_links: "links to", implements: "implements", amends: "amends", consignment_wide: "applies across the same consignment as" };
/** The reason an explicit relationship states by itself (the legal edges, which need no evidence) and what a plain citation says. */
const RELATION_REASON: Readonly<Record<string, string>> = { Supersedes: "Replaces prior statutory provisions.", "Superseded by": "Succeeded by newer legislation.", Implements: "Technical execution of the parent framework.", "Implemented by": "Carried out by implementing legislation.", Amends: "Modifies the text or scope of the other.", "Amended by": "Updated by a later amendment.", "Conflicts with": "Its requirements conflict with this one.", "Depends on": "This depends on it being in force." };
const CITATION_REASON: Readonly<Record<string, string>> = { References: "Cited directly in the source text.", "Referenced by": "Cites this item directly in its source text." };

/** The entities an evidence entry names: typed canonical names, or the stored detail ("both name reg:x, y"). */
const entityNames = (e: EdgeEvidence): string[] => {
  const typed = (e.entities ?? []).map((x) => x.canonicalName?.trim() ?? "").filter(Boolean);
  return typed.length ? typed : typeof e.detail === "string" && KIND_OF_SIGNAL[e.signal] === "entity" ? e.detail.replace(/^both name /, "").split(", ").map((x) => x.replace(/^reg:/, "")).filter(Boolean) : [];
};
/** The scenario or object tokens of an evidence entry: typed `tokens`, or the stored detail ("both touch x", the intersection's lists). */
const tokensOf = (e: EdgeEvidence, kind: "scenario" | "object"): string[] => {
  if (e.tokens?.length) return e.tokens;
  const d = e.detail;
  if (typeof d === "string") return [d.replace(/^both (?:touch|address) /, "")].filter(Boolean);
  const lists = d && typeof d === "object" ? (d as IntersectionDetail) : null;
  return (kind === "scenario" ? lists?.scenarios : lists?.objects) ?? [];
};
const dateWords = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? formatDate(iso.slice(0, 10)) : iso);

/** One sentence from the strongest evidence the basis holds, in words; null when the basis holds none that states anything (an entry of the same source alone is corroboration, not a connection). */
function evidenceSentence(evidence: readonly EdgeEvidence[]): string | null {
  const kinds = evidence.flatMap((e) => (KIND_OF_SIGNAL[e.signal] ? [{ e, kind: KIND_OF_SIGNAL[e.signal] as EvidenceKind }] : []));
  for (const k of KIND_ORDER) {
    const hits = kinds.filter((x) => x.kind === k).map((x) => x.e);
    const first = hits[0];
    if (!first) continue;
    if (k === "entity") {
      const n = [...new Set(hits.flatMap(entityNames))];
      if (n.length) return `Both concern ${joinLabels(n)}.`;
    } else if (k === "coupled") {
      const [a, b] = entityNames(first);
      const rel = RELATION_WORDS[first.relation as (typeof RELATIONS)[number]];
      if (a && b && rel) return `${a} ${rel} ${b}, so a change in one reaches the other.`;
    } else if (k === "obligation") {
      if (first.dutyHolder && first.date) return `Both bind ${first.dutyHolder} by ${dateWords(first.date)}.`;
    } else if (k === "jurisdiction") {
      const where = first.tokens ?? (typeof first.detail === "string" ? /^both in (.+?) on /.exec(first.detail)?.[1]?.split("/") : undefined);
      if (where?.length) return `Both apply to ${joinLabels(where)} operations.`;
    } else {
      const scn = [...new Set(hits.flatMap((e) => tokensOf(e, "scenario")).map(labelForScenario).filter(Boolean))];
      const obj = [...new Set(hits.flatMap((e) => tokensOf(e, "object")).map(labelForComplianceObject).filter(Boolean))];
      const words = scn.length ? scn : obj;
      if (words.length) return `Shared operating context: ${joinLabels(words)}.`;
    }
  }
  return null;
}

// -- the causal chain: the facts of the two items, strongest kind first --------------------------------------------------------------------------
const FACT_KIND: Readonly<Record<string, number>> = { statutory_computations: 0, market_series: 1, reroute_events: 2, corridor_carbon_intensity: 2, grid_connection_queues: 2, regional_operational_facts: 2, regional_data_facts: 2, state_cost_facts: 2, oem_tech_roadmaps: 3 };
const figureWords = (s: FactSummary): string => [s.value, s.unit && s.currency && !s.unit.includes(s.currency) ? `${s.currency}/${s.unit}` : (s.unit ?? s.currency)].filter((x) => x !== null && x !== undefined && x !== "").join(" ");
/** One fact as one plain sentence, from the typed fields it holds; null when the link states nothing a reader could use. */
function factSentence(f: FactLink): string | null {
  const s = f.summary;
  const name = s.label ?? s.title ?? f.entity.canonicalName;
  const asOf = s.asOf ? ` (as of ${dateWords(s.asOf)})` : "";
  switch (FACT_KIND[f.refTable]) {
    case 0: return s.date ? `${f.entity.canonicalName} binds ${s.dutyHolder ?? "operators"} from ${dateWords(s.date)}${s.penalty ? ` (penalty ${s.penalty})` : ""}.` : null;
    case 1:
      if (s.delta && Number.isFinite(s.delta.pct)) return `${name} ${s.delta.pct >= 0 ? "rose" : "fell"} ${Math.abs(s.delta.pct).toFixed(1)}% over the last ${s.delta.window === "1w" ? "week" : "month"}.`;
      return s.value !== null && s.value !== undefined ? `${name} stands at ${figureWords(s)}${asOf}.` : null;
    case 2: return s.value !== null && s.value !== undefined ? `${name}: ${figureWords(s)}${asOf}.` : null;
    case 3: return s.trl != null || s.abatementCost ? `${name}${s.trl != null ? ` is at technology readiness level ${s.trl}` : ""}${s.abatementCost ? `${s.trl != null ? "; abatement costs " : " abates at "}${s.abatementCost}` : ""}.` : null;
    default: return null;
  }
}
const byStrength = (both: ReadonlySet<string>) => (x: FactLink, y: FactLink): number => (FACT_KIND[x.refTable] ?? 9) - (FACT_KIND[y.refTable] ?? 9) || Number(both.has(y.entity.id)) - Number(both.has(x.entity.id)) || x.hop - y.hop;
/** The chain two items share: at most one sentence per kind (obligation, figure, operational constraint, technology), a fact on an entity both sides hold first. */
function chainOf(a: readonly FactLink[], b: readonly FactLink[]): string | null {
  const both = new Set(a.map((f) => f.entity.id).filter((id) => b.some((g) => g.entity.id === id)));
  const ranked = [...a, ...b].filter((f) => FACT_KIND[f.refTable] !== undefined).sort(byStrength(both));
  const lines: string[] = [];
  for (const kind of [0, 1, 2, 3]) {
    const line = ranked.filter((f) => FACT_KIND[f.refTable] === kind).map(factSentence).find((x): x is string => !!x);
    if (line && !lines.includes(line)) lines.push(line);
  }
  return lines.length ? lines.join(" ") : null;
}

/**
 * Why two items are connected, as one short passage a reader without a sustainability background can act on: the reader's own rationale first, then what an explicit relationship says, then the chain of
 * facts the two share, then the evidence in words, and last the shared operating context. Null for an edge whose only evidence is the same source (it corroborates; it never connects).
 */
export function reasonFor(c: { basis: EdgeBasisIn; origin: string; label: string }, facts: { self?: readonly FactLink[]; other?: readonly FactLink[] } = {}): string | null {
  const { evidence, rationale } = asBasis(c.basis);
  return rationale ?? RELATION_REASON[c.label] ?? chainOf(facts.self ?? [], facts.other ?? []) ?? evidenceSentence(evidence) ?? (evidence.length > 0 && c.origin === "provenance_discovery" ? null : (CITATION_REASON[c.label] ?? null));
}

/** "Supersedes", "Implements"...; a generic edge reads by direction (References, Referenced by). */
function labelForConnection(relationship: string | undefined, direction: string | undefined): string {
  return (relationship ? RELATIONSHIP_LABEL[relationship] : undefined) ?? (direction === "outgoing" ? "References" : "Referenced by");
}

/** What a set of edges is mostly linked by, in words: the canonical names of the entities they share and the scenarios they touch, most frequent first. The same source is not a link. */
export function linkedByWords(bases: readonly EdgeBasisIn[], top = 3): string[] {
  const tally = new Map<string, number>();
  for (const b of bases) {
    const words = new Set(asBasis(b).evidence.flatMap((e) => [...entityNames(e), ...(KIND_OF_SIGNAL[e.signal] === "scenario" ? tokensOf(e, "scenario").map(labelForScenario) : [])]).filter(Boolean));
    for (const w of words) tally.set(w, (tally.get(w) ?? 0) + 1);
  }
  return [...tally].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, top).map(([w]) => w);
}

/** The family a forming chain is called, from the detector kind (or the method id) the typed `patternFamily` names. */
export const familyWords = (family: string | undefined | null): string | null => (family ? (PATTERN_COPY[PATTERN_METHODS[family as keyof typeof PATTERN_METHODS]?.id ?? family]?.forming ?? null) : null);

export function buildConnectionRows(connections: readonly ConnectionIn[] | null | undefined, lookup: ResourceLookup | null | undefined, ctx: { self?: readonly FactLink[]; facts?: FactsByItem } = {}): ConnectionRow[] {
  const seen = new Set<string>();
  const rows: { row: ConnectionRow; score: number }[] = [];
  for (const c of connections ?? []) {
    const ref = lookup?.[c?.id];
    if (!c || !c.id || seen.has(c.id) || !ref) continue;
    const origin = c.origin || "manual";
    const label = labelForConnection(c.relationship, c.direction);
    const basis = asBasis(c.basis);
    const developing = origin === "candidate";
    const reason = reasonFor({ basis: c.basis, origin, label }, { self: ctx.self ?? [], other: ctx.facts?.get(c.uuid ?? c.id) ?? [] });
    if (!reason && !developing) continue;
    seen.add(c.id);
    const surface = c.surface || "uncategorized";
    const row: ConnectionRow = { id: c.id, title: ref.title, priority: ref.priority, label, surface, href: surfaceHref(surface, c.id), origin, discovered: origin === "provenance_discovery" && basis.evidence.length > 0, reason: reason ?? "A chain is forming between the two." };
    if (developing) row.developing = { family: familyWords(basis.missing?.patternFamily), next: basis.missing?.truth?.trim() || null };
    rows.push({ row, score: typeof c.score === "number" ? c.score : 0 });
  }
  rows.sort((a, b) => Number(!!a.row.developing) - Number(!!b.row.developing) || (a.row.discovered !== b.row.discovered ? (a.row.discovered ? -1 : 1) : a.row.discovered && b.row.discovered ? b.score - a.score : 0));
  return rows.map((r) => r.row);
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
    rows.push({ id, title: ref.title, priority: ref.priority, label, surface: "regulations", href: surfaceHref("regulations", id), origin: "manual", discovered: false, reason: RELATION_REASON[label] as string });
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

// -- the two sentences under a figure, and the rows that move with an item --------------------------------------------------------------------------
const KIND_LABELS = ["Obligation", "Price or figure", "Operating constraint", "Technology"] as const;
const surfaceName = (s: string): string => SURFACE_LABELS[s] ?? s;
/**
 * "Why this matters" under a figure: two lines. The first names the regulation(s) tied to the figure's entity with the next dated obligation and the penalty; the second the operations, market or research item tied to it. A line with
 * nothing behind it names the surface that holds nothing (an absence is a sentence, never a blank). `links` are the items tied to the figure's row (facts-join readFactItems); `subject` is the figure in the reader's words.
 */
export function whyLines(links: readonly FactLink[], subject: string): string[] {
  const regs = links.filter((l) => l.surface === "regulations");
  const others = links.filter((l) => l.surface !== "regulations");
  const reg = regs[0];
  const first = reg ? `${reg.summary.title ?? reg.entity.canonicalName}${reg.summary.date ? `: next dated obligation ${dateWords(reg.summary.date)}` : ""}${reg.summary.penalty ? `, penalty ${reg.summary.penalty}` : ""}${regs.length > 1 ? `, and ${regs.length - 1} more regulation${regs.length > 2 ? "s" : ""}` : ""}.` : `No regulation in the ledger is tied to ${subject} yet.`;
  const other = others[0];
  const second = other ? `Also tied: ${other.summary.title ?? other.entity.canonicalName} (${surfaceName(other.surface)})${others.length > 1 ? `, and ${others.length - 1} more` : ""}.` : `No operations, market or research item is tied to ${subject} yet.`;
  return [first, second];
}

/** The rows that move with an item: each structured row tied to its entities as one line (the figure, its date or delta, and the entity it moves through), the strongest kind first. */
export function movesRows(links: readonly FactLink[], limit = 8): { kind: string; line: string }[] {
  const seen = new Set<string>();
  const out: { kind: string; line: string }[] = [];
  for (const f of [...links].filter((l) => FACT_KIND[l.refTable] !== undefined).sort(byStrength(new Set()))) {
    const s = factSentence(f);
    const via = f.hop === 1 ? ` It reaches this item through ${f.entity.canonicalName}.` : "";
    const key = `${f.refTable}/${f.refId}`;
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: KIND_LABELS[FACT_KIND[f.refTable] as number] as string, line: `${s}${via}` });
    if (out.length >= limit) break;
  }
  return out;
}
