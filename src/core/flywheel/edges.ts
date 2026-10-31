// Ported from old_repo/src/lib/connections/write-edges.mjs (lines 1-276)
// Ported from old_repo/src/lib/connections/pair-view.mjs (lines 1-113)
// The ONE item_cross_references writer and the pair view. INV-187: one row per ordered pair, both directions stored and collapsed at the reader (ADR-018);
// a machine writer owns only its own origins (provenance_discovery, and candidate: a developing connection, upgraded in place when a later pass scores it at the threshold and deleted when it no longer scores the floor): it skips and COUNTS a manual or foreign-origin row and an admin-tombstoned pair,
// carries an intersection basis entry through a refresh, and snapshots every row it refreshes (through an injected sink). The existing-edge read is
// scoped to the pairs about to be written (B-0244/1983), every failed chunk is counted, and a failed read throws.
import type { Db } from "@/core/db";
import { fetchAllByIdChunks, fetchAllRows } from "@/core/db";
import { log } from "@/core/shared/log";
import { isPairTombstoned, readAllCorrections, readConnectionCorrectionsForMany, tombstonedPairKeys } from "@/core/corrections";

import relationships from "./data/relationships.json";
import { basisWith, CANDIDATE_ORIGIN, evidenceOf, type BasisEntry, type EdgeBasis } from "./discover";
import { basisDetailText, basisEntryKey, buildIntersectionEntry, isCrossSurface, isIntersectionEntry, type IntersectionDetail, type IntersectionPair } from "./intersections";
import { CONFIG } from "./config";

export const RELATIONSHIP_LABEL: Readonly<Record<string, string>> = relationships.label;

export const DISCOVERY_ORIGIN = "provenance_discovery";
export interface EdgeRow {
  id?: string;
  source_item_id: string;
  target_item_id: string;
  relationship: string;
  origin: string;
  basis?: EdgeBasis | null;
  score?: number | null;
}
const pairKey = (s: string, t: string): string => `${s}|${t}`;
const canonKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
const stableJson = (x: unknown): string => JSON.stringify(x, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

export type SnapshotSink = (table: string, priorRows: readonly EdgeRow[]) => void | Promise<void>;
export interface WriteOpts {
  chunk?: number;
  snapshot?: SnapshotSink;
  /** The harness run taking the snapshots: with no explicit sink, prior rows go to edge_snapshots under this run (migration 0027). */
  runId?: string;
}

/** The default sink: prior rows are stored in edge_snapshots, tied to the harness run, in chunks. A failed write throws, so the overwrite it guards never happens. */
export function edgeSnapshotSink(sb: Db, runId: string, chunk = 500): SnapshotSink {
  return async (table, priorRows) => {
    for (let i = 0; i < priorRows.length; i += chunk) {
      const { error } = await sb.from("edge_snapshots").insert({ run_id: runId, table_name: table, rows: priorRows.slice(i, i + chunk) });
      if (error) throw new Error(`edge snapshot write failed: ${error.message}`);
    }
  };
}
const sinkOf = (sb: Db, opts: WriteOpts): SnapshotSink | undefined => opts.snapshot ?? (opts.runId ? edgeSnapshotSink(sb, opts.runId) : undefined);
export interface DiscoveredWriteResult {
  inserted: number;
  refreshed: number;
  /** Candidates that scored the threshold this pass: origin candidate to provenance_discovery in place. */
  upgraded: number;
  /** Candidates deleted: not found this pass (below the floor, or beyond the cap) for a source the pass owns. */
  candidatesDeleted: number;
  /** A candidate found for a pair that already holds an established discovery edge: the edge stands. */
  skippedEstablished: number;
  skippedForeignOrigin: number;
  skippedTombstoned: number;
  written: number;
  failedChunks: number;
  notes: string[];
}

/** The existing rows for exactly these pairs (grouped by source, targets in id chunks). */
async function readEdgesForPairs(sb: Db, pairs: readonly { source_item_id: string; target_item_id: string }[]): Promise<Map<string, EdgeRow>> {
  const bySource = new Map<string, Set<string>>();
  for (const p of pairs) bySource.set(p.source_item_id, (bySource.get(p.source_item_id) ?? new Set()).add(p.target_item_id));
  const out = new Map<string, EdgeRow>();
  for (const [source, targets] of bySource) {
    const rows = await fetchAllByIdChunks<EdgeRow>([...targets], async (slice) => {
      const { data, error } = await sb.from("item_cross_references").select("*").eq("source_item_id", source).in("target_item_id", slice);
      if (error) throw new Error(`write-edges: existing-edge read failed: ${error.message}`);
      return (data ?? []) as EdgeRow[];
    });
    for (const r of rows) out.set(pairKey(r.source_item_id, r.target_item_id), r);
  }
  return out;
}

/** Every edge row (the corpus pass reads once, ordered by id, capped). A failed page throws. */
export async function readAllEdges(sb: Db): Promise<EdgeRow[]> {
  return fetchAllRows<EdgeRow>((from, to) => sb.from("item_cross_references").select("id, source_item_id, target_item_id, relationship, origin, basis, score").order("id", { ascending: true }).range(from, to), { cap: 1_000_000 });
}

async function upsertChunks(sb: Db, rows: readonly Record<string, unknown>[], chunk: number, label: string, out: { written: number; failedChunks: number; notes: string[] }): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    const batch = rows.slice(i, i + chunk);
    const { error } = await sb.from("item_cross_references").upsert(batch, { onConflict: "source_item_id,target_item_id" });
    if (error) {
      out.failedChunks += 1;
      out.notes.push(`${label} chunk ${i} failed: ${error.message}`);
      log.warn(`[write-edges] ${label} chunk ${i} failed: ${error.message}`);
    } else out.written += batch.length;
  }
}

const OWNED_ORIGINS: readonly string[] = [DISCOVERY_ORIGIN, CANDIDATE_ORIGIN];

/**
 * Write discovered edges (relationship related; origin provenance_discovery, or candidate for a developing connection). Tombstoned pairs and rows of another origin are skipped and counted; an own-origin row is refreshed (snapshotted first), keeps the intersection entries it
 * already carries and a reader's rationale; a candidate that now scores the threshold is upgraded in place; a candidate found for a pair that holds an established edge leaves the edge alone. `candidateSources` are the items whose developing connections this pass fully
 * recomputed: their candidate rows it did not write again are deleted (snapshotted first).
 */
export async function writeDiscoveredEdges(sb: Db, edges: readonly EdgeRow[], opts: WriteOpts & { candidateSources?: readonly string[] } = {}): Promise<DiscoveredWriteResult> {
  const result: DiscoveredWriteResult = { inserted: 0, refreshed: 0, upgraded: 0, candidatesDeleted: 0, skippedEstablished: 0, skippedForeignOrigin: 0, skippedTombstoned: 0, written: 0, failedChunks: 0, notes: [] };
  if (!edges.length && !opts.candidateSources?.length) return result;
  const ids = [...new Set(edges.flatMap((e) => [e.source_item_id, e.target_item_id]))];
  const tombstones = ids.length ? tombstonedPairKeys(await readConnectionCorrectionsForMany(sb, ids)) : new Set<string>();
  const owner = await readEdgesForPairs(sb, edges);
  const writable: EdgeRow[] = [];
  const prior: EdgeRow[] = [];
  for (const e of edges) {
    if (isPairTombstoned(tombstones, e.source_item_id, e.target_item_id)) {
      result.skippedTombstoned += 1;
      continue;
    }
    const existing = owner.get(pairKey(e.source_item_id, e.target_item_id));
    if (existing?.origin && !OWNED_ORIGINS.includes(existing.origin)) {
      result.skippedForeignOrigin += 1;
      continue;
    }
    if (existing?.origin === DISCOVERY_ORIGIN && e.origin === CANDIDATE_ORIGIN) {
      result.skippedEstablished += 1;
      continue;
    }
    if (!existing) {
      result.inserted += 1;
      writable.push(e);
      continue;
    }
    prior.push(existing);
    if (existing.origin === CANDIDATE_ORIGIN) {
      result[e.origin === DISCOVERY_ORIGIN ? "upgraded" : "refreshed"] += 1;
      writable.push(e);
      continue;
    }
    result.refreshed += 1;
    const carried = evidenceOf(existing.basis).filter(isIntersectionEntry);
    const incoming = evidenceOf(e.basis);
    writable.push({ ...e, basis: basisWith(existing.basis, carried.length && !incoming.some(isIntersectionEntry) ? [...incoming, ...carried] : incoming) });
  }
  const sink = sinkOf(sb, opts);
  const written = new Set(edges.map((e) => pairKey(e.source_item_id, e.target_item_id)));
  const stale = opts.candidateSources?.length
    ? (await fetchAllByIdChunks<EdgeRow>(opts.candidateSources, (slice) => fetchAllRows<EdgeRow>((from, to) => sb.from("item_cross_references").select("id, source_item_id, target_item_id, relationship, origin, basis, score").eq("origin", CANDIDATE_ORIGIN).in("source_item_id", slice).order("id", { ascending: true }).range(from, to) as never, { cap: 500_000 }), { chunk: 500, manyPerId: true })).filter((r) => !written.has(pairKey(r.source_item_id, r.target_item_id)))
    : [];
  if (sink && (prior.length || stale.length)) await sink("item_cross_references", [...prior, ...stale]);
  await upsertChunks(sb, writable as unknown as Record<string, unknown>[], opts.chunk ?? 200, "discovered", result);
  const gone = stale.map((r) => r.id).filter((x): x is string => !!x);
  for (let i = 0; i < gone.length; i += 100) {
    const { error } = await sb.from("item_cross_references").delete().in("id", gone.slice(i, i + 100));
    if (error) {
      result.failedChunks += 1;
      result.notes.push(`candidate delete chunk ${i} failed: ${error.message}`);
    } else result.candidatesDeleted += Math.min(100, gone.length - i);
  }
  return result;
}

export interface IntersectionPlan {
  inserts: EdgeRow[];
  updates: { row: EdgeRow; basis: EdgeBasis }[];
  removals: { row: EdgeRow; basis: EdgeBasis }[];
  deletes: EdgeRow[];
  /** Candidate rows the intersection upgrades: the insert overwrites them. */
  replaced: EdgeRow[];
  unchanged: number;
  skippedManual: number;
  skippedTombstoned: number;
}

/** Plan the intersection basis entries over the existing rows: append to a row without changing its relationship, origin or score; drop an entry no longer holding. */
function planIntersectionEdges(existingRows: readonly EdgeRow[], pairs: readonly Pick<IntersectionPair, "a" | "b" | "shared_scenarios" | "shared_objects" | "strength" | "tier">[], tombstones?: Set<string>): IntersectionPlan {
  const byKey = new Map<string, EdgeRow>();
  for (const r of existingRows) byKey.set(pairKey(r.source_item_id, r.target_item_id), r);
  const plan: IntersectionPlan = { inserts: [], updates: [], removals: [], deletes: [], replaced: [], unchanged: 0, skippedManual: 0, skippedTombstoned: 0 };
  const holding = new Set<string>();
  for (const p of pairs) {
    holding.add(canonKey(p.a, p.b));
    const entry = buildIntersectionEntry(p);
    for (const [s, t] of [[p.a, p.b], [p.b, p.a]] as const) {
      if (isPairTombstoned(tombstones, s, t)) {
        plan.skippedTombstoned += 1;
        continue;
      }
      const row = byKey.get(pairKey(s, t));
      if (!row || row.origin === CANDIDATE_ORIGIN) {
        if (row) plan.replaced.push(row);
        plan.inserts.push({ source_item_id: s, target_item_id: t, relationship: "related", origin: DISCOVERY_ORIGIN, basis: [entry], score: entry.weight ?? null });
        continue;
      }
      if (row.origin === "manual") {
        plan.skippedManual += 1;
        continue;
      }
      const basis = evidenceOf(row.basis);
      const priorEntry = basis.find(isIntersectionEntry);
      if (priorEntry && stableJson(priorEntry) === stableJson(entry)) {
        plan.unchanged += 1;
        continue;
      }
      plan.updates.push({ row, basis: basisWith(row.basis, [...basis.filter((b) => !isIntersectionEntry(b)), entry]) });
    }
  }
  for (const row of existingRows) {
    const basis = evidenceOf(row.basis);
    if (!basis.some(isIntersectionEntry) || holding.has(canonKey(row.source_item_id, row.target_item_id))) continue;
    if (row.origin === "manual") {
      plan.skippedManual += 1;
      continue;
    }
    const rest = basis.filter((b) => !isIntersectionEntry(b));
    if (!rest.length && row.origin === DISCOVERY_ORIGIN) plan.deletes.push(row);
    else plan.removals.push({ row, basis: basisWith(row.basis, rest) });
  }
  return plan;
}

/** The edge rows as they would stand after the plan (what a dry run clusters over). */
function projectEdgeRows(existingRows: readonly EdgeRow[], plan: IntersectionPlan): EdgeRow[] {
  const drop = new Set([...plan.deletes, ...plan.replaced].map((r) => pairKey(r.source_item_id, r.target_item_id)));
  const patched = new Map<string, EdgeBasis>();
  for (const u of [...plan.updates, ...plan.removals]) patched.set(pairKey(u.row.source_item_id, u.row.target_item_id), u.basis);
  const out: EdgeRow[] = [];
  for (const r of existingRows) {
    const k = pairKey(r.source_item_id, r.target_item_id);
    if (!drop.has(k)) out.push(patched.has(k) ? { ...r, basis: patched.get(k) as EdgeBasis } : r);
  }
  return [...out, ...plan.inserts.map((r) => ({ ...r }))];
}

export interface IntersectionWriteResult {
  inserted: number;
  updated: number;
  removed: number;
  deleted: number;
  unchanged: number;
  skippedManual: number;
  skippedTombstoned: number;
  written: number;
  failedChunks: number;
  notes: string[];
  projected: EdgeRow[] | null;
}

/** Write the intersection plan. `existing` is the corpus pass's single edge read; a dry run writes nothing and returns the projected rows. */
export async function writeIntersectionEdges(sb: Db, pairs: readonly IntersectionPair[], opts: WriteOpts & { dry?: boolean; existing: readonly EdgeRow[] }): Promise<IntersectionWriteResult> {
  const tombstones = tombstonedPairKeys(await readAllCorrections(sb));
  const plan = planIntersectionEdges(opts.existing, pairs, tombstones);
  const out: IntersectionWriteResult = { inserted: plan.inserts.length, updated: plan.updates.length, removed: plan.removals.length, deleted: plan.deletes.length, unchanged: plan.unchanged, skippedManual: plan.skippedManual, skippedTombstoned: plan.skippedTombstoned, written: 0, failedChunks: 0, notes: [], projected: null };
  if (opts.dry) return { ...out, projected: projectEdgeRows(opts.existing, plan) };
  const priors = [...plan.updates.map((u) => u.row), ...plan.removals.map((u) => u.row), ...plan.deletes, ...plan.replaced];
  const sink = sinkOf(sb, opts);
  if (sink && priors.length) await sink("item_cross_references", priors);
  const upserts: Record<string, unknown>[] = [
    ...(plan.inserts as unknown as Record<string, unknown>[]),
    ...[...plan.updates, ...plan.removals].map(({ row, basis }) => ({ source_item_id: row.source_item_id, target_item_id: row.target_item_id, relationship: row.relationship, origin: row.origin, score: row.score ?? null, basis })),
  ];
  await upsertChunks(sb, upserts, opts.chunk ?? 200, "intersection", out);
  const delIds = plan.deletes.map((r) => r.id).filter((x): x is string => !!x);
  for (let i = 0; i < delIds.length; i += 100) {
    const ids = delIds.slice(i, i + 100);
    const { error } = await sb.from("item_cross_references").delete().in("id", ids);
    if (error) {
      out.failedChunks += 1;
      out.notes.push(`intersection delete chunk ${i} failed: ${error.message}`);
    } else out.written += ids.length;
  }
  return out;
}

/** The score band of a pair; an unscored (explicitly linked) pair is "explicit". */
function bandOf(score: number | null | undefined): "strong" | "medium" | "weak" | "explicit" {
  if (score == null || !Number.isFinite(score)) return "explicit";
  return score >= CONFIG.pairBands.strong ? "strong" : score >= CONFIG.pairBands.medium ? "medium" : "weak";
}

export interface PairView {
  a: string;
  b: string;
  score: number | null;
  basis: BasisEntry[];
  explicitly_linked: boolean;
  intersection: { scenarios: string[]; objects: string[]; strength: number; tier: string } | null;
}
/** Collapse both directions of each edge to one pair (ADR-018): the best discovery score, the union of the basis, whether a person or an extractor linked it. */
function collapsePairs(edgeRows: readonly Pick<EdgeRow, "source_item_id" | "target_item_id" | "origin" | "score" | "basis">[] | null | undefined): Map<string, PairView> {
  const pairs = new Map<string, PairView>();
  for (const e of edgeRows ?? []) {
    const s = e?.source_item_id;
    const t = e?.target_item_id;
    if (!s || !t || s === t || e.origin === CANDIDATE_ORIGIN) continue;
    const key = canonKey(s, t);
    const [a, b] = s < t ? [s, t] : [t, s];
    let p = pairs.get(key);
    if (!p) pairs.set(key, (p = { a, b, score: null, basis: [], explicitly_linked: false, intersection: null }));
    if (e.origin === DISCOVERY_ORIGIN) {
      const sc = typeof e.score === "number" && Number.isFinite(e.score) ? e.score : null;
      if (sc != null) p.score = p.score == null ? sc : Math.max(p.score, sc);
    } else p.explicitly_linked = true;
    for (const bs of evidenceOf(e.basis)) {
      if (isIntersectionEntry(bs)) {
        const d: IntersectionDetail | null = bs.detail && typeof bs.detail === "object" ? bs.detail : null;
        if (d && (!p.intersection || (d.strength ?? 0) > p.intersection.strength)) p.intersection = { scenarios: d.scenarios ?? [], objects: d.objects ?? [], strength: d.strength ?? 0, tier: d.tier ?? "weak" };
        continue;
      }
      if (bs && bs.signal && !p.basis.some((x) => basisEntryKey(x) === basisEntryKey(bs))) p.basis.push(bs);
    }
  }
  for (const p of pairs.values()) p.basis.sort((x, y) => (y.weight ?? 0) - (x.weight ?? 0) || String(x.signal).localeCompare(String(y.signal)) || basisDetailText(x).localeCompare(basisDetailText(y)));
  return pairs;
}

export interface PairItem {
  title?: string | null;
  legacy_id?: string | null;
  priority?: string | null;
  intersection_summary?: string | null;
  item_type?: string | null;
  domain?: number | null;
}
/** Pairs for the Map and the admin intersections view, scored pairs above `minScore` or explicitly linked, strongest first, capped. */
export function assemblePairs(edgeRows: readonly EdgeRow[], itemsById: ReadonlyMap<string, PairItem>, opts: { minScore?: number; limit?: number } = {}) {
  const minScore = opts.minScore ?? 0.3;
  const out: { item_a_id: string; item_a_title: string | null; item_a_legacy_id: string | null; item_a_priority: string | null; item_a_intersection_summary: string | null; item_b_id: string; item_b_title: string | null; item_b_legacy_id: string | null; item_b_priority: string | null; item_b_intersection_summary: string | null; basis: BasisEntry[]; intersection: (NonNullable<PairView["intersection"]> & { cross_surface: boolean | null }) | null; explicitly_linked: boolean; score: number | null; band: ReturnType<typeof bandOf> }[] = [];
  for (const p of collapsePairs(edgeRows).values()) {
    const A = itemsById.get(p.a);
    const B = itemsById.get(p.b);
    if (!A || !B) continue;
    if (p.score != null ? p.score < minScore && !p.explicitly_linked : !p.explicitly_linked) continue;
    out.push({
      item_a_id: p.a, item_a_title: A.title ?? null, item_a_legacy_id: A.legacy_id ?? null, item_a_priority: A.priority ?? null, item_a_intersection_summary: A.intersection_summary ?? null,
      item_b_id: p.b, item_b_title: B.title ?? null, item_b_legacy_id: B.legacy_id ?? null, item_b_priority: B.priority ?? null, item_b_intersection_summary: B.intersection_summary ?? null,
      basis: p.basis, intersection: p.intersection ? { ...p.intersection, cross_surface: isCrossSurface(A, B) } : null, explicitly_linked: p.explicitly_linked, score: p.score, band: bandOf(p.score),
    });
  }
  out.sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || x.item_a_id.localeCompare(y.item_a_id) || x.item_b_id.localeCompare(y.item_b_id));
  const limited = out.slice(0, Math.max(1, opts.limit ?? 100));
  const count = (band: string) => limited.filter((r) => r.band === band).length;
  return { pairs: limited, stats: { total: limited.length, explicit_count: limited.filter((r) => r.explicitly_linked).length, by_band: { strong: count("strong"), medium: count("medium"), weak: count("weak"), explicit: count("explicit") } } };
}
