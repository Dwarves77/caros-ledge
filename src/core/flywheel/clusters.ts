// PATTERN-SYNTHESIS-1 (operator, 2026-10-26: "an intelligence engine that does not look across the corpus from many angles so AI can define patterns into grounded analysis fails the core product mandate"): the cluster assembler. A detector no longer gates what the AI sees: the
// live graph is read from many angles and every multi-surface group of rows is handed over with the angles it can be read from. Four axes, each producing clusters over the four fronts (regulations, market, operations, research):
//   A shared_entity   facts from two or more fronts that share a specific entity (0 hops);
//   B relation_hops   facts reached from an entity over entity_relations in one or two hops (any relation token the live table holds; the list is not filtered);
//   C scope_window    several instruments or operational events filed on the same scope (a mode together with a jurisdiction, or a hub, node or corridor) inside one overlapping window: regulatory stacking generalised to operational events;
//   D threshold       a dated mandate against a measured capacity, a penalty ceiling against an abatement cost or a technology (TRL 1 to 9), a pending deadline or a document-date burst against a market or operational move: the six detectors, run as ONE input, find these.
// The angle of a cluster is assigned mechanically from which tables and columns intersect in it; the six angle tokens are a closed vocabulary of angle kinds, not entity names. No word list, alias or phrase is read here: the join is entity ids, relation rows, dates and quantities.
// Nothing is dropped silently: `truncated` counts the clusters not returned (beyond the limit) and the rows cut from a cluster beyond maxRows.
import { createHash } from "node:crypto";

import { rowsByIds, type Db } from "@/core/db";

import { PATTERNS } from "./patterns/config";
import { DETECTORS } from "./patterns/detect";
import { loadPatternInput } from "./patterns/load";
import type { Fact, Pattern, PatternInput, PatternKind } from "./patterns/types";

export type Angle = "mandate_vs_capacity" | "penalty_vs_abatement" | "cross_modal_competition" | "regulatory_stacking" | "lead_lag" | "maturity_vs_statute";
export type Axis = "shared_entity" | "relation_hops" | "scope_window" | "threshold";
export type Surface = "regulations" | "market" | "operations" | "research";
export interface ClusterRow {
  table: string;
  pk: string;
  surface: Surface;
  entity_ids: string[];
  /** The row's time coordinate: an obligation's due_date, else first_deadline, else date_of_application; a forward event's event_date; a claim's capture document date; else the day it was observed. */
  date: string | null;
  /** The row's quantity in its normalised unit (a mandated quantity, a statutory maximum, a measured value, a result, a TRL). */
  figure: { value: number; unit: string } | null;
  /** The capture the row quotes, when it quotes one. */
  quote_capture_id: string | null;
}
export interface Cluster {
  /** sha256 of the sorted row keys, first 16 hex. */
  id: string;
  anchor_entity_ids: string[];
  rows: ClusterRow[];
  surfaces: string[];
  angles: Angle[];
  /** The fewest relation hops at which the rows are reached. */
  hops: 0 | 1 | 2;
  axes: Axis[];
  /** SYNTH-FIX-1 B1: the rows left out of the bundle, by rule; the export states each in its truncation block. */
  dropped: { year_only_events: number; generic_assessments: number };
}
/** A forward event stored at year precision whose kind is no more than a target: a recital's year as 1 January, not an event. */
export const isYearOnlyTarget = (e: { date_precision?: string | null; event_kind?: string | null }): boolean => e.date_precision === "year" && (!e.event_kind || e.event_kind === "target");

const SURFACES: readonly string[] = ["regulations", "market", "operations", "research"];
const MS_PER_DAY = 86_400_000;
/** What each detector finds, as an angle: the burst of document-dated claims is read with the pending deadlines (lead and lag). */
const ANGLE_OF_KIND: Record<PatternKind, Angle> = { velocity: "lead_lag", mandateCapacity: "mandate_vs_capacity", leadLag: "lead_lag", crossModal: "cross_modal_competition", penaltyAbatement: "penalty_vs_abatement", regulatoryStacking: "regulatory_stacking" };
/** Relations whose far end couples a different mode or a competing use of the same feedstock or grid zone (the cross-modal angle reads them). */
const CROSS_RELATIONS: ReadonlySet<string> = new Set(["competes_for_feedstock", "shares_grid_zone", "corridor_links", "fuel_for_mode", "feedstock_of"]);

const rowKey = (f: Pick<Fact, "table" | "pk">): string => `${f.table}/${f.pk}`;
const clusterId = (keys: Iterable<string>): string => createHash("sha256").update([...new Set(keys)].sort().join("\n")).digest("hex").slice(0, 16);
const dateOf = (f: Fact): string | null => f.due ?? f.docAt ?? f.at ?? null;

const rowOf = (f: Fact): ClusterRow | null =>
  SURFACES.includes(f.surface) ? { table: f.table, pk: f.pk, surface: f.surface as Surface, entity_ids: [...f.entities].sort(), date: dateOf(f), figure: f.qty !== null && f.unit ? { value: f.qty, unit: f.unit } : f.trl !== null ? { value: f.trl, unit: "trl" } : null, quote_capture_id: f.capture ?? null } : null;

/** The angles a group of facts can be read from, assigned from the roles (and so the tables and columns) that intersect in it. */
function anglesOf(facts: readonly Fact[], relations: ReadonlySet<string> = new Set()): Angle[] {
  const has = (...roles: string[]) => facts.some((f) => roles.includes(f.role));
  const out = new Set<Angle>();
  if (has("ratchet") && has("capacity")) out.add("mandate_vs_capacity");
  if (has("ceiling") && has("abatement", "tech")) out.add("penalty_vs_abatement");
  if (facts.some((f) => f.role === "tech" && f.trl !== null) && has("ceiling", "ratchet")) out.add("maturity_vs_statute");
  const owners = new Set(facts.filter((f) => ["ratchet", "ceiling", "trigger"].includes(f.role) && f.item).map((f) => f.item));
  if (owners.size >= 2) out.add("regulatory_stacking");
  const pending = facts.some((f) => f.role === "trigger" && !f.resolved && f.due);
  if (pending && facts.some((f) => ["series", "capacity", "move", "tech"].includes(f.role) || (f.role === "claim" && f.surface !== "regulations"))) out.add("lead_lag");
  const modes = new Set(facts.flatMap((f) => f.modes));
  if (modes.size >= 2 && [...relations].some((r) => CROSS_RELATIONS.has(r))) out.add("cross_modal_competition");
  return [...out].sort();
}

interface Draft {
  facts: Map<string, Fact>;
  anchors: Set<string>;
  /** The fewest relation hops at which the rows are reached. */
  hops: 0 | 1 | 2;
  axes: Set<Axis>;
  relations: Set<string>;
  /** The detectors that found this group of rows. */
  kinds: Set<PatternKind>;
}

/**
 * The multi-surface clusters of the live graph, ranked by the number of surfaces then rows. `limit` is how many are returned; `minSurfaces` (default 2) is how many fronts a cluster must span; `maxRows` (default 40) caps the rows of one cluster, cutting evenly across fronts and tables.
 * Reads only. The assembler runs the six detectors as one input among the angles; none of them gates a cluster.
 */
// `now` is the clock of the read; a caller with an injected clock passes it, and the default is the process clock read through the performance API (the wall-clock rule bans Date.now() and new Date())
export async function assembleClusters(db: Db, o: { limit: number; minSurfaces?: number; maxRows?: number; now?: Date; input?: PatternInput }): Promise<{ clusters: Cluster[]; truncated: number }> {
  const minSurfaces = o.minSurfaces ?? 2;
  const maxRows = o.maxRows ?? 40;
  const input = o.input ?? (await loadPatternInput(db, o.now ?? new Date(performance.timeOrigin + performance.now()))).input;
  const generic = new Set(PATTERNS.genericClasses);
  const classOf = (e: string): string => input.classOf?.(e) ?? "";
  const specific = (e: string): boolean => !generic.has(classOf(e));
  const facts = input.facts.filter((f) => SURFACES.includes(f.surface));
  // the stored precision of a forward event's date (the method's own fact config is untouched): a year-only target is dropped from the rows below
  const precision = new Map((await rowsByIds<{ id: string; date_precision: string | null }>(db, "item_forward_events", "id, date_precision", facts.filter((f) => f.table === "item_forward_events").map((f) => f.pk), "id", "id")).map((r) => [r.id, r.date_precision]));
  const byEntity = new Map<string, Fact[]>();
  for (const f of facts) for (const e of f.entities) byEntity.set(e, [...(byEntity.get(e) ?? []), f]);
  const drafts = new Map<string, Draft>();
  const add = (members: readonly Fact[], anchors: readonly string[], hops: 0 | 1 | 2, axis: Axis, relations: Iterable<string> = [], kind?: PatternKind): void => {
    const unique = new Map(members.map((f) => [`${rowKey(f)}/${f.role}`, f]));
    if (new Set([...unique.values()].map((f) => f.surface)).size < minSurfaces) return;
    const id = clusterId([...unique.values()].map(rowKey));
    const held = drafts.get(id);
    if (held) {
      anchors.forEach((a) => held.anchors.add(a));
      held.axes.add(axis);
      held.hops = Math.min(held.hops, hops) as 0 | 1 | 2;
      for (const r of relations) held.relations.add(r);
      if (kind) held.kinds.add(kind);
      return;
    }
    drafts.set(id, { facts: unique, anchors: new Set(anchors), hops, axes: new Set([axis]), relations: new Set(relations), kinds: new Set(kind ? [kind] : []) });
  };

  // A and B: around each specific entity, the rows filed under it (0 hops), then under what it reaches in one and two hops over the relation rows
  for (const [entity, own] of byEntity) {
    if (!specific(entity)) continue;
    add(own, [entity], 0, "shared_entity");
    const hop1 = input.related(entity).filter((r) => specific(r.entity));
    const reached1 = new Map<string, string>(hop1.map((r) => [r.entity, r.relation]));
    const members1 = [...own, ...hop1.flatMap((r) => byEntity.get(r.entity) ?? [])];
    add(members1, [entity, ...reached1.keys()], 1, "relation_hops", reached1.values());
    const hop2 = hop1.flatMap((h) => input.related(h.entity).filter((r) => specific(r.entity) && r.entity !== entity && !reached1.has(r.entity)).map((r) => ({ ...r, via: h.relation })));
    if (hop2.length) add([...members1, ...hop2.flatMap((r) => byEntity.get(r.entity) ?? [])], [entity, ...reached1.keys(), ...hop2.map((r) => r.entity)], 2, "relation_hops", [...reached1.values(), ...hop2.flatMap((r) => [r.via, r.relation])]);
  }

  // C: several instruments or operational events on one scope (a mode with a jurisdiction, or a hub, node or corridor) inside one window
  const window = PATTERNS.regulatoryStacking.windowDays * MS_PER_DAY;
  const dated = facts.flatMap((f) => (dateOf(f) ? [{ f, ms: Date.parse(`${dateOf(f)}T00:00:00Z`) }] : []));
  const scopes = new Map<string, typeof dated>();
  for (const d of dated) {
    const modes = d.f.entities.filter((e) => classOf(e) === "mode");
    const places = d.f.entities.filter((e) => ["jurisdiction", "hub", "node", "corridor"].includes(classOf(e)));
    const keys = [...places.filter((p) => classOf(p) !== "jurisdiction"), ...modes.flatMap((m) => places.filter((p) => classOf(p) === "jurisdiction").map((j) => [m, j].sort().join("+")))];
    for (const k of keys) scopes.set(k, [...(scopes.get(k) ?? []), d]);
  }
  for (const [scope, list] of scopes) {
    const rows = [...list].sort((a, b) => a.ms - b.ms);
    let best: typeof rows = [];
    for (const start of rows) {
      const inWin = rows.filter((r) => r.ms >= start.ms && r.ms - start.ms <= window);
      const owners = (xs: typeof rows) => new Set(xs.map((r) => r.f.item ?? rowKey(r.f))).size;
      if (owners(inWin) > owners(best)) best = inWin;
    }
    if (new Set(best.map((r) => r.f.item ?? rowKey(r.f))).size >= 2) add(best.map((r) => r.f), scope.split("+"), 0, "scope_window");
  }

  // D: the six detectors, as one input: each pattern's evidence is a cluster read from its angle
  const byKey = new Map(input.facts.map((f) => [`${rowKey(f)}/${f.role}`, f]));
  const byRow = new Map(input.facts.map((f) => [rowKey(f), f]));
  for (const [kind, detect] of Object.entries(DETECTORS) as [PatternKind, (i: PatternInput) => Pattern[]][]) {
    for (const p of detect(input)) {
      const members = p.evidence.flatMap((e) => (e.role ? byKey.get(`${e.table}/${e.pk}/${e.role}`) : undefined) ?? byRow.get(`${e.table}/${e.pk}`) ?? []);
      add(members, [p.entity], 0, "threshold", [], kind);
    }
  }

  let cut = 0;
  const clusters: Cluster[] = [...drafts.entries()].map(([id, d]) => {
    const all = [...d.facts.values()];
    const angles = new Set<Angle>(anglesOf(all, d.relations));
    for (const k of d.kinds) angles.add(ANGLE_OF_KIND[k]);
    const rows = new Map<string, ClusterRow>();
    const dropped = { year_only_events: 0, generic_assessments: 0 };
    const shared = new Set(all.filter((f) => f.table !== "research_assessments").flatMap((f) => f.entities));
    for (const f of all) {
      const r = rowOf(f);
      if (!r || rows.has(rowKey(f))) continue;
      // B1: a year-only target is no event, and a research assessment stays only when it is filed under a specific entity that another row of the cluster is filed under (a 0-hop join, not one reached by a generic class or a hop)
      if (f.table === "item_forward_events" && isYearOnlyTarget({ date_precision: precision.get(f.pk) ?? null, event_kind: f.kind })) { dropped.year_only_events += 1; continue; }
      if (f.table === "research_assessments" && !f.entities.some((e) => shared.has(e) && specific(e))) { dropped.generic_assessments += 1; continue; }
      rows.set(rowKey(f), r);
    }
    // the rows kept when a cluster is over the cap: round-robin across fronts, so no front is cut away whole
    const perSurface = SURFACES.map((s) => [...rows.values()].filter((r) => r.surface === s).sort((a, b) => String(b.date).localeCompare(String(a.date)) || (a.pk < b.pk ? -1 : 1)));
    const kept: ClusterRow[] = [];
    for (let i = 0; kept.length < maxRows && perSurface.some((l) => i < l.length); i += 1) for (const l of perSurface) if (l[i] && kept.length < maxRows) kept.push(l[i] as ClusterRow);
    cut += rows.size - kept.length;
    return { id, anchor_entity_ids: [...d.anchors].sort(), rows: kept, surfaces: [...new Set(kept.map((r) => r.surface))].sort(), angles: [...angles].sort(), hops: d.hops, axes: [...d.axes].sort(), dropped };
  }).filter((c) => new Set(c.rows.map((r) => r.surface)).size >= minSurfaces);
  clusters.sort((a, b) => b.surfaces.length - a.surfaces.length || b.rows.length - a.rows.length || (a.id < b.id ? -1 : 1));
  const returned = clusters.slice(0, Math.max(0, o.limit));
  return { clusters: returned, truncated: clusters.length - returned.length + cut };
}
