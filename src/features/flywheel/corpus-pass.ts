// Ported from old_repo/scripts/connections/analyze-corpus.mjs (lines 20-385)
// Ported from old_repo/src/lib/connections/signal-candidates.mjs (lines 35-116)
// Ported from old_repo/src/lib/connections/signal-confidence.mjs (lines 115-142, 211-274)
// The whole-corpus pass, one function with the guarded service client injected (the old script had a raw client and no main guard). Steps: cross-surface
// intersections as appended basis entries; shared-entity adoption for pairs with no edge (the old decisive regulation-identifier signal, now a discovery
// basis); label-propagation clustering into themes REPLACED WHOLESALE inside one connection_theme_runs row that stores the delta against the prior set
// (INV-190); coverage gaps and anticipated targets as flags born resolved; every open flywheel-signal flag resolved by the pass (INV-034). A dry run writes
// nothing and returns the same counts; a second dry run over unchanged data yields an empty theme delta.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import { clusterThemes, type Theme } from "@/core/flywheel/cluster";
import { regulationEntityTokens, SIGNATURE_CAP } from "@/core/flywheel/signature";
import { DISCOVERY_ORIGIN, readAllEdges, writeDiscoveredEdges, writeIntersectionEdges, type EdgeRow, type SnapshotSink } from "@/core/flywheel/edges";
import { ANTICIPATE_NAMESPACE, createdBy, GAP_NAMESPACE, readFlagKeys, reflectResolved, SIGNAL_NAMESPACE, type FlagCounts } from "@/core/flywheel/flags";
import { anticipateFindings, computeAnticipatedTargets, detectGaps, gapFindings, type ForwardEventRow } from "@/core/flywheel/gaps";
import { detectIntersections, type IntersectionItem } from "@/core/flywheel/intersections";
import { diffThemes, type ThemeDelta } from "@/core/flywheel/themes";
import { CONFIG } from "@/core/flywheel/config";
import type { RunResult } from "@/core/sources/run-result";

export interface CorpusDeps {
  sb: Db;
  now: () => Date;
  snapshot?: SnapshotSink;
}
export interface CorpusInput {
  dry: boolean;
}
interface CorpusItem extends IntersectionItem {
  jurisdiction_iso?: string[] | null;
  added_date?: string | null;
  title?: string | null;
  topic_tags?: string[] | null;
  canonical_instrument_key?: string | null;
  instrument_entity_id?: string | null;
}
const ITEM_COLUMNS = "id, item_type, domain, priority, jurisdiction_iso, added_date, title, topic_tags, canonical_instrument_key, operational_scenario_tags, compliance_object_tags, related_items";
const PER_TOKEN_ITEM_CAP = 6;

/** Pairs of items that name the same regulation identifier in their titles and share no edge in either direction: they get a shared_entity edge in both directions. */
export function sharedEntityEdges(items: readonly { id: string; title?: string | null }[], existing: readonly Pick<EdgeRow, "source_item_id" | "target_item_id">[], entityTokens: (title: string | null | undefined) => string[]): EdgeRow[] {
  const connected = new Set(existing.map((e) => (e.source_item_id < e.target_item_id ? `${e.source_item_id}|${e.target_item_id}` : `${e.target_item_id}|${e.source_item_id}`)));
  const byToken = new Map<string, string[]>();
  for (const it of items) for (const t of entityTokens(it.title)) byToken.set(t, [...(byToken.get(t) ?? []), it.id]);
  const byPair = new Map<string, { a: string; b: string; values: Set<string> }>();
  for (const token of [...byToken.keys()].sort()) {
    const ids = [...new Set(byToken.get(token))].sort().slice(0, PER_TOKEN_ITEM_CAP);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const [a, b] = [ids[i] as string, ids[j] as string];
        if (connected.has(`${a}|${b}`)) continue;
        const p = byPair.get(`${a}|${b}`) ?? { a, b, values: new Set<string>() };
        p.values.add(token.startsWith("reg:") ? token.slice(4) : token);
        byPair.set(`${a}|${b}`, p);
      }
    }
  }
  const weight = CONFIG.weights.shared_entity;
  const out: EdgeRow[] = [];
  for (const key of [...byPair.keys()].sort()) {
    const { a, b, values } = byPair.get(key) as { a: string; b: string; values: Set<string> };
    const basis = [{ signal: "shared_entity", detail: `both name ${[...values].sort().map((v) => `"${v}"`).join(", ")} in their titles`, weight }];
    for (const [s, t] of [[a, b], [b, a]] as const) out.push({ source_item_id: s, target_item_id: t, relationship: "related", origin: DISCOVERY_ORIGIN, basis, score: Math.min(1, weight) });
  }
  return out;
}

export async function corpusPass(deps: CorpusDeps, input: CorpusInput): Promise<RunResult<{ themeDelta: ThemeDelta | null; themes: number }>> {
  const { sb } = deps;
  const notes: string[] = [];
  const nowIso = deps.now().toISOString();
  const counts: Record<string, number> = {};
  let failed = 0;
  const items = await fetchAllRows<CorpusItem>((from, to) => sb.from("intelligence_items").select(ITEM_COLUMNS).eq("provenance_status", "verified").eq("is_archived", false).order("id", { ascending: true }).range(from, to), { cap: SIGNATURE_CAP });
  let edges = await readAllEdges(sb);
  Object.assign(counts, { nodes: items.length, edges_read: edges.length });

  const pairs = detectIntersections(items);
  const inter = await writeIntersectionEdges(sb, pairs, { dry: input.dry, existing: edges, ...(deps.snapshot ? { snapshot: deps.snapshot } : {}) });
  Object.assign(counts, { intersection_pairs: pairs.length, intersection_cross_surface: pairs.filter((p) => p.cross_surface === true).length, intersection_inserted: inter.inserted, intersection_updated: inter.updated, intersection_removed: inter.removed, intersection_deleted: inter.deleted, intersection_unchanged: inter.unchanged, intersection_skipped_manual: inter.skippedManual, intersection_failed_chunks: inter.failedChunks });
  notes.push(...inter.notes);
  if (!input.dry && inter.failedChunks) return { counts, outcome: "failed", notes: [...notes, "refusing to cluster over a half-written graph"], data: { themeDelta: null, themes: 0 } };

  const sharedEdges = sharedEntityEdges(items, input.dry ? (inter.projected ?? edges) : edges, regulationEntityTokens);
  const shared = input.dry ? { written: 0, failedChunks: 0, notes: [] as string[] } : await writeDiscoveredEdges(sb, sharedEdges, deps.snapshot ? { snapshot: deps.snapshot } : {});
  Object.assign(counts, { shared_entity_edges: sharedEdges.length, shared_entity_written: shared.written, shared_entity_failed_chunks: shared.failedChunks });
  if (shared.failedChunks) failed += shared.failedChunks;
  notes.push(...shared.notes);

  edges = input.dry ? (inter.projected ?? edges) : await readAllEdges(sb);
  const nodes = items.map((it) => ({ id: it.id, item_type: it.item_type ?? null, domain: it.domain ?? null, dates: it.added_date }));
  const clustered = clusterThemes(nodes, edges.map((e) => ({ source: e.source_item_id, target: e.target_item_id, score: e.score ?? null, basis: e.basis ?? null })));

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
  const themeDelta = diffThemes(prior, clustered.themes);
  Object.assign(counts, { delta_persisted: themeDelta.summary.persisted, delta_renamed: themeDelta.summary.renamed, delta_split: themeDelta.summary.split, delta_merged: themeDelta.summary.merged, delta_dissolved: themeDelta.summary.dissolved, delta_appeared: themeDelta.summary.appeared });
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
    const reflected: FlagCounts[] = [await reflectResolved(sb, GAP_NAMESPACE, gapFindings(gaps), "corpus-pass", nowIso), await reflectResolved(sb, ANTICIPATE_NAMESPACE, anticipateFindings(anticipated), "corpus-pass", nowIso)];
    for (const r of reflected) {
      failed += r.failed;
      notes.push(...r.notes);
    }
    Object.assign(counts, { gap_flags_inserted: reflected[0]?.inserted ?? 0, anticipate_flags_inserted: reflected[1]?.inserted ?? 0 });
    const open = (await readFlagKeys(sb, SIGNAL_NAMESPACE, "open")).map((f) => f.id);
    if (open.length) {
      const res = await sb.from("integrity_flags").update({ status: "resolved", resolved_at: nowIso, resolved_by: "corpus-pass", resolution_note: `superseded: shared regulation identifiers are a discovery basis (${createdBy(SIGNAL_NAMESPACE, "shared_regulation_identifier")}); no signal flag stays open after a pass` }).in("id", open);
      if (res.error) {
        failed += open.length;
        notes.push(`signal flag resolution failed: ${res.error.message}`);
      }
    }
    counts.signal_flags_resolved = failed ? 0 : open.length;
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
