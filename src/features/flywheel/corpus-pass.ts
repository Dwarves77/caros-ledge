// Ported from old_repo/scripts/connections/analyze-corpus.mjs (lines 20-385)
// Ported from old_repo/src/lib/connections/signal-candidates.mjs (lines 35-116)
// Ported from old_repo/src/lib/connections/signal-confidence.mjs (lines 115-142)
// Ported from old_repo/src/lib/connections/signal-confidence.mjs (lines 211-274)
// The whole-corpus pass, one function with the guarded service client injected (the old script had a raw client and no main guard). Steps: cross-surface
// intersections as appended basis entries; label-propagation clustering into themes REPLACED WHOLESALE inside one connection_theme_runs row that stores the delta against the prior set
// (INV-190), over the edges that connect (a developing connection and a shared source alone do not); coverage gaps and anticipated targets as flags born OPEN and resolved by the pass that no longer finds them. A dry run writes
// nothing and returns the same counts; a second dry run over unchanged data yields an empty theme delta.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import { clusterThemes, type Theme } from "@/core/flywheel/cluster";
import { CONFIG } from "@/core/flywheel/config";
import { SIGNATURE_CAP } from "@/core/flywheel/signature";
import { readAllEdges, writeIntersectionEdges, type SnapshotSink } from "@/core/flywheel/edges";
import { entityRefs } from "@/core/flywheel/facts-join";
import { ANTICIPATE_NAMESPACE, createdBy, GAP_NAMESPACE, reflectFindings, type FlagCounts } from "@/core/flywheel/flags";
import { anticipateFindings, computeAnticipatedTargets, detectGaps, gapFindings, type ForwardEventRow } from "@/core/flywheel/gaps";
import { detectIntersections, type IntersectionItem } from "@/core/flywheel/intersections";
import { diffThemes, type ThemeDelta } from "@/core/flywheel/themes";
import type { RunResult } from "@/core/sources/run-result";

export interface CorpusDeps {
  sb: Db;
  now: () => Date;
  snapshot?: SnapshotSink;
  /** The harness run this pass belongs to: the default snapshot sink writes the prior edge rows to edge_snapshots under it. */
  runId?: string;
}
export interface CorpusInput {
  dry: boolean;
}
interface CorpusItem extends IntersectionItem {
  jurisdiction_iso?: string[] | null;
  added_date?: string | null;
  topic_tags?: string[] | null;
  canonical_instrument_key?: string | null;
}
const ITEM_COLUMNS = "id, item_type, domain, priority, jurisdiction_iso, added_date, topic_tags, canonical_instrument_key, operational_scenario_tags, compliance_object_tags, related_items";
export async function corpusPass(deps: CorpusDeps, input: CorpusInput): Promise<RunResult<{ themeDelta: ThemeDelta | null; themes: number }>> {
  const { sb } = deps;
  const notes: string[] = [];
  const nowIso = deps.now().toISOString();
  const counts: Record<string, number> = {};
  let failed = 0;
  const snapshotOpts = deps.snapshot ? { snapshot: deps.snapshot } : deps.runId ? { runId: deps.runId } : {};
  const items = await fetchAllRows<CorpusItem>((from, to) => sb.from("intelligence_items").select(ITEM_COLUMNS).eq("provenance_status", "verified").eq("is_archived", false).order("id", { ascending: true }).range(from, to), { cap: SIGNATURE_CAP });
  let edges = await readAllEdges(sb);
  Object.assign(counts, { nodes: items.length, edges_read: edges.length });

  const pairs = detectIntersections(items);
  const inter = await writeIntersectionEdges(sb, pairs, { dry: input.dry, existing: edges, ...snapshotOpts });
  Object.assign(counts, { intersection_pairs: pairs.length, intersection_cross_surface: pairs.filter((p) => p.cross_surface === true).length, intersection_inserted: inter.inserted, intersection_updated: inter.updated, intersection_removed: inter.removed, intersection_deleted: inter.deleted, intersection_unchanged: inter.unchanged, intersection_skipped_manual: inter.skippedManual, intersection_failed_chunks: inter.failedChunks });
  notes.push(...inter.notes);
  if (!input.dry && inter.failedChunks) return { counts, outcome: "failed", notes: [...notes, "refusing to cluster over a half-written graph"], data: { themeDelta: null, themes: 0 } };

  edges = input.dry ? (inter.projected ?? edges) : await readAllEdges(sb);
  const nodes = items.map((it) => ({ id: it.id, item_type: it.item_type ?? null, domain: it.domain ?? null, dates: it.added_date }));
  const clusteredAll = clusterThemes(nodes, edges.map((e) => ({ source: e.source_item_id, target: e.target_item_id, score: e.score ?? null, basis: e.basis ?? null, origin: e.origin })));
  // Ruling 58 (theme.minConvergence): a cluster below the floor writes no theme and its members stay unthemed; a prior theme it replaces is dissolved with reason below_floor.
  const floor = CONFIG.theme.minConvergence;
  const clustered = { ...clusteredAll, themes: clusteredAll.themes.filter((t) => t.convergence >= floor) };
  const belowFloor = clusteredAll.themes.filter((t) => t.convergence < floor);

  const wsRes = await sb.from("workspace_settings").select("jurisdiction_weights").limit(1);
  if (wsRes.error) throw new Error(`workspace_settings read failed: ${wsRes.error.message}`);
  const weights = (wsRes.data?.[0] as { jurisdiction_weights?: Record<string, unknown> } | undefined)?.jurisdiction_weights ?? {};
  const jurisdictionsByMember: Record<string, string[]> = {};
  for (const it of items) if (it.jurisdiction_iso?.length) jurisdictionsByMember[it.id] = it.jurisdiction_iso;
  const gaps = detectGaps(clustered.themes, { profile: { jurisdictions: weights }, jurisdictionsByMember });

  const events = await fetchAllRows<ForwardEventRow>((from, to) => sb.from("item_forward_events").select("id, intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_span, confidence").order("id", { ascending: true }).range(from, to), { cap: 500_000 });
  const itemTopics: Record<string, string[]> = {};
  const itemInstrumentKeys: Record<string, string> = {};
  for (const it of items) {
    itemTopics[it.id] = Array.isArray(it.topic_tags) ? it.topic_tags : [];
    if (it.canonical_instrument_key) itemInstrumentKeys[it.id] = it.canonical_instrument_key;
  }
  const anticipated = computeAnticipatedTargets(events, { itemTopics, itemInstrumentKeys }, { now: deps.now() });
  Object.assign(counts, { themes: clustered.themes.length, nodes_clustered: clustered.nodesClustered, edges_used: clustered.edgesUsed, rounds: clustered.rounds, gaps: gaps.length, anticipated: anticipated.length });

  const prior = await fetchAllRows<{ id: string; member_ids: string[] }>((from, to) => sb.from("connection_themes").select("id, member_ids").order("id", { ascending: true }).range(from, to), { cap: 100_000 });
  const themeDelta = diffThemes(prior, clustered.themes, { belowFloor });
  Object.assign(counts, { delta_persisted: themeDelta.summary.persisted, delta_renamed: themeDelta.summary.renamed, delta_split: themeDelta.summary.split, delta_merged: themeDelta.summary.merged, delta_dissolved: themeDelta.summary.dissolved, delta_below_floor: themeDelta.below_floor?.length ?? 0, delta_appeared: themeDelta.summary.appeared });
  if (input.dry) return { counts, outcome: "ok", notes: [...notes, "dry: nothing written"], data: { themeDelta, themes: clustered.themes.length } };

  const run = await sb.from("connection_theme_runs").insert({ started_at: nowIso, status: "running", args: { dry: false, intersections: { pairs: pairs.length } }, nodes_read: nodes.length, edges_read: edges.length }).select("id").single();
  if (run.error) throw new Error(`connection_theme_runs insert failed: ${run.error.message}`);
  const runId = (run.data as { id: string }).id;
  try {
    if (prior.length) {
      const del = await sb.from("connection_themes").delete().in("id", prior.map((p) => p.id));
      if (del.error) throw new Error(`connection_themes delete failed: ${del.error.message}`);
    }
    const rows = clustered.themes.map((t: Theme) => ({ id: t.id, member_ids: t.members, dominant_signals: t.dominantSignals, surfaces: t.surfaces, density: t.density, convergence: t.convergence, pivots: t.pivots }));
    if (rows.length) {
      const ins = await sb.from("connection_themes").insert(rows);
      if (ins.error) throw new Error(`connection_themes insert failed: ${ins.error.message}`);
    }
    const reflected: FlagCounts[] = [await reflectFindings(sb, GAP_NAMESPACE, gapFindings(gaps, await entityRefs(sb, gaps.flatMap((g) => g.missing.entity ?? []))), "corpus-pass", nowIso, { owns: (by) => !by.startsWith(createdBy(GAP_NAMESPACE, "pattern_")) }), await reflectFindings(sb, ANTICIPATE_NAMESPACE, anticipateFindings(anticipated), "corpus-pass", nowIso)];
    for (const r of reflected) {
      failed += r.failed;
      notes.push(...r.notes);
    }
    Object.assign(counts, { gap_flags_inserted: reflected[0]?.inserted ?? 0, gap_flags_resolved: reflected[0]?.resolved ?? 0, anticipate_flags_inserted: reflected[1]?.inserted ?? 0, anticipate_flags_resolved: reflected[1]?.resolved ?? 0 });
    const done = await sb.from("connection_theme_runs").update({ finished_at: deps.now().toISOString(), status: "ok", nodes_clustered: clustered.nodesClustered, edges_used: clustered.edgesUsed, themes_written: rows.length, gaps_flagged: gaps.length, rounds: clustered.rounds, theme_delta: themeDelta }).eq("id", runId);
    if (done.error) throw new Error(`connection_theme_runs close failed: ${done.error.message}`);
    const verify = await sb.from("connection_themes").select("id", { count: "exact", head: true });
    if (verify.error || verify.count !== rows.length) notes.push(`verify: connection_themes holds ${verify.count ?? "?"} rows, ${rows.length} written`);
    return { counts, outcome: failed || notes.some((n) => n.startsWith("verify:")) ? "partial" : "ok", notes, data: { themeDelta, themes: rows.length } };
  } catch (e) {
    await sb.from("connection_theme_runs").update({ finished_at: deps.now().toISOString(), status: "error", error_message: (e instanceof Error ? e.message : String(e)).slice(0, 2000) }).eq("id", runId);
    return { counts, outcome: "failed", notes: [...notes, e instanceof Error ? e.message : String(e)], data: { themeDelta: null, themes: 0 } };
  }
}
