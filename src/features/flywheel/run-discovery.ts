// Ported from old_repo/src/lib/connections/run-discovery.mjs (lines 22-52)
// Ported from old_repo/scripts/connections/discover-for-items.mjs (lines 23-66)
// Ported from old_repo/scripts/connections/discover-for-items.mjs (lines 133-170)
// The per-mint / per-update discovery entry (CLAUDE.md rule 17, INV-194) and discovery for a set of ids or since a date. ONE path: load the item's own
// signature, load the corpus signatures, score, write `related` edges through the one writer. The corpus pass shares these modules.
import type { Db } from "@/core/db";
import { computeTagFrequencies, discoverConnections } from "@/core/flywheel/discover";
import { writeDiscoveredEdges, type DiscoveredWriteResult, type EdgeRow, type SnapshotSink } from "@/core/flywheel/edges";
import { entityTokensOf, loadObligationKeys, loadSignatures, SIGNATURE_COLUMNS, type Signature } from "@/core/flywheel/signature";
import type { RunResult } from "@/core/sources/run-result";

export interface DiscoveryDeps {
  sb: Db;
  now?: () => Date;
  snapshot?: SnapshotSink;
}
export interface DiscoverOptions {
  threshold?: number;
  limit?: number;
}

/** One item's signature, whatever its provenance (a minted item is scored even before it is visible in the verified corpus). Null when it does not exist. */
export async function loadItemSignature(sb: Db, itemId: string, keys?: ReadonlyMap<string, string[]>): Promise<Signature | null> {
  const { data, error } = await sb.from("intelligence_items").select(SIGNATURE_COLUMNS).eq("id", itemId).maybeSingle();
  if (error) throw new Error(`discovery: item ${itemId} read failed: ${error.message}`);
  if (!data) return null;
  const held = (keys ?? (await loadObligationKeys(sb))).get(itemId) ?? [];
  const row = data as unknown as Signature;
  return { ...row, entity_ids: entityTokensOf(row), obligation_keys: held };
}

export function edgesFor(item: Signature, corpus: readonly Signature[], opts: DiscoverOptions = {}): EdgeRow[] {
  const freqMap = computeTagFrequencies(corpus);
  return discoverConnections(item, corpus, { ...opts, freqMap }).map((c) => ({ source_item_id: item.id, target_item_id: c.target, relationship: "related", origin: "provenance_discovery", basis: c.basis, score: c.score }));
}

/** Discovery for one item against the verified live corpus. Returns the edges it found and what the writer did with them. A failure to read throws; a failed chunk is in the result. */
export async function runConnectionDiscovery(deps: DiscoveryDeps, itemId: string, opts: DiscoverOptions & { dry?: boolean } = {}): Promise<{ found: number; write: DiscoveredWriteResult | null; missing: boolean }> {
  const keys = await loadObligationKeys(deps.sb);
  const item = await loadItemSignature(deps.sb, itemId, keys);
  if (!item) return { found: 0, write: null, missing: true };
  const corpus = await loadSignatures(deps.sb, { excludeId: itemId, withObligations: false });
  const edges = edgesFor(item, corpus.map((c) => ({ ...c, obligation_keys: keys.get(c.id) ?? [] })), opts);
  if (!edges.length || opts.dry) return { found: edges.length, write: null, missing: false };
  return { found: edges.length, write: await writeDiscoveredEdges(deps.sb, edges, deps.snapshot ? { snapshot: deps.snapshot } : {}), missing: false };
}

/** Discovery for a set of ids, or for every item created since a date. Dry unless told otherwise; counts are returned for the recorder. */
export async function discoverForItems(deps: DiscoveryDeps, input: { ids?: readonly string[]; since?: string; dry: boolean; threshold?: number; limit?: number }): Promise<RunResult> {
  const notes: string[] = [];
  if ((!input.ids || !input.ids.length) === !input.since) return { counts: {}, outcome: "failed", notes: ["pass exactly one of ids or since"] };
  if (input.since && Number.isNaN(Date.parse(input.since))) return { counts: {}, outcome: "failed", notes: [`since is not a parseable date: ${JSON.stringify(input.since)}`] };
  const corpus = await loadSignatures(deps.sb);
  const wanted = input.ids ? new Set(input.ids) : null;
  const sinceMs = input.since ? Date.parse(input.since) : 0;
  const targets = corpus.filter((it) => (wanted ? wanted.has(it.id) : !!it.created_at && Date.parse(it.created_at) >= sinceMs));
  const missing = wanted ? [...wanted].filter((id) => !targets.some((t) => t.id === id)) : [];
  if (missing.length) notes.push(`${missing.length} requested id(s) not in the verified live corpus (ignored): ${missing.join(", ")}`);
  const freqMap = computeTagFrequencies(corpus);
  const all: EdgeRow[] = [];
  let cross = 0;
  let withEdges = 0;
  for (const item of targets) {
    const conns = discoverConnections(item, corpus, { freqMap, ...(input.threshold !== undefined ? { threshold: input.threshold } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) });
    if (!conns.length) continue;
    withEdges += 1;
    cross += conns.filter((c) => c.crossSurface).length;
    for (const c of conns) all.push({ source_item_id: item.id, target_item_id: c.target, relationship: "related", origin: "provenance_discovery", basis: c.basis, score: c.score });
  }
  const counts: Record<string, number> = { corpus: corpus.length, targets: targets.length, items_with_edges: withEdges, edges_found: all.length, cross_surface: cross, written: 0, skipped_foreign_origin: 0, skipped_tombstoned: 0, failed_chunks: 0 };
  if (input.dry || !all.length) return { counts, outcome: "ok", notes: input.dry ? [...notes, "dry: nothing written"] : notes };
  const w = await writeDiscoveredEdges(deps.sb, all, deps.snapshot ? { snapshot: deps.snapshot } : {});
  Object.assign(counts, { written: w.written, inserted: w.inserted, refreshed: w.refreshed, skipped_foreign_origin: w.skippedForeignOrigin, skipped_tombstoned: w.skippedTombstoned, failed_chunks: w.failedChunks });
  return { counts, outcome: w.failedChunks ? "partial" : "ok", notes: [...notes, ...w.notes] };
}
