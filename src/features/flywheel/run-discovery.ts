// Ported from old_repo/src/lib/connections/run-discovery.mjs (lines 22-52)
// Ported from old_repo/scripts/connections/discover-for-items.mjs (lines 23-66)
// Ported from old_repo/scripts/connections/discover-for-items.mjs (lines 133-170)
// The per-mint / per-update discovery entry (CLAUDE.md rule 17, INV-194) and discovery for a set of ids or since a date. ONE path: load the signatures (with the entity graph), score, write `related` edges through the one writer. A pair that does not reach the threshold but
// holds entity evidence or the candidate floor is written as a developing connection (origin candidate) naming the surface truth that would complete it; the writer upgrades it in place when a later pass reaches the threshold and deletes the ones a pass no longer finds.
// The corpus pass shares these modules.
import type { Db } from "@/core/db";
import { CANDIDATE_ORIGIN, computeTagFrequencies, discoverAll, type Connection, type EdgeBasis } from "@/core/flywheel/discover";
import { DISCOVERY_ORIGIN, writeDiscoveredEdges, type DiscoveredWriteResult, type EdgeRow, type SnapshotSink } from "@/core/flywheel/edges";
import { missingFor, readEntityFacts } from "@/core/flywheel/facts-join";
import { loadObligationKeys, loadSignatures, SIGNATURE_COLUMNS, withEntityGraph, type Signature } from "@/core/flywheel/signature";
import { surfaceOf } from "@/core/routing";
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
async function loadItemSignature(sb: Db, itemId: string, keys?: ReadonlyMap<string, string[]>): Promise<Signature | null> {
  const { data, error } = await sb.from("intelligence_items").select(SIGNATURE_COLUMNS).eq("id", itemId).maybeSingle();
  if (error) throw new Error(`discovery: item ${itemId} read failed: ${error.message}`);
  if (!data) return null;
  const held = (keys ?? (await loadObligationKeys(sb))).get(itemId) ?? [];
  const [row] = await withEntityGraph(sb, [data as unknown as Signature]);
  return { ...(row as Signature), obligation_keys: held };
}

/** The entity a developing connection is about, for the words of what is missing: the first named entity of its evidence. */
const entityNameOf = (c: Connection): string | null => {
  for (const b of c.basis) {
    const t = b.tokens?.entities?.[0] ?? b.tokens?.coupled?.[0]?.parent;
    if (t?.name) return t.name;
  }
  return null;
};

/** The edges of a set of items against the corpus: the material connections, and the developing ones each with the surface truth that would complete the pair (read from the figures filed near the two items). */
async function planEdges(sb: Db, targets: readonly Signature[], corpus: readonly Signature[], opts: DiscoverOptions): Promise<{ kept: EdgeRow[]; candidates: EdgeRow[]; cross: number; withEdges: number }> {
  const freqMap = computeTagFrequencies(corpus);
  const byId = new Map([...corpus, ...targets].map((s) => [s.id, s]));
  const found = targets.map((item) => ({ item, ...discoverAll(item, corpus, { freqMap, ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}), ...(opts.limit !== undefined ? { limit: opts.limit } : {}) }) }));
  const facts = await readEntityFacts(sb, [...new Set(found.flatMap((f) => (f.developing.length ? [f.item.id, ...f.developing.map((d) => d.target)] : [])))]);
  const surfacesOf = (s: Signature): string[] => [surfaceOf(s.item_type, s.domain), ...(facts.get(s.id) ?? []).map((l) => l.surface)];
  const row = (item: Signature, c: Connection, origin: string, basis: EdgeBasis): EdgeRow => ({ source_item_id: item.id, target_item_id: c.target, relationship: "related", origin, basis, score: c.score });
  const kept = found.flatMap(({ item, kept: k }) => k.map((c) => row(item, c, DISCOVERY_ORIGIN, c.basis)));
  const candidates = found.flatMap(({ item, developing }) =>
    developing.map((c) => {
      const other = byId.get(c.target) as Signature;
      const missing = missingFor(new Set(item.entity_classes), new Set(other.entity_classes), new Set([...surfacesOf(item), ...surfacesOf(other)]), entityNameOf(c));
      return row(item, c, CANDIDATE_ORIGIN, { evidence: c.basis, missing });
    }),
  );
  return { kept, candidates, cross: found.reduce((n, f) => n + f.kept.filter((c) => c.crossSurface).length, 0), withEdges: found.filter((f) => f.kept.length).length };
}

/** Discovery for one item against the verified live corpus. Returns the edges it found and what the writer did with them. A failure to read throws; a failed chunk is in the result. */
export async function runConnectionDiscovery(deps: DiscoveryDeps, itemId: string, opts: DiscoverOptions & { dry?: boolean } = {}): Promise<{ found: number; candidates: number; write: DiscoveredWriteResult | null; missing: boolean }> {
  const keys = await loadObligationKeys(deps.sb);
  const item = await loadItemSignature(deps.sb, itemId, keys);
  if (!item) return { found: 0, candidates: 0, write: null, missing: true };
  const corpus = (await loadSignatures(deps.sb, { excludeId: itemId, withObligations: false })).map((c) => ({ ...c, obligation_keys: keys.get(c.id) ?? [] }));
  const plan = await planEdges(deps.sb, [item], corpus, opts);
  if (opts.dry) return { found: plan.kept.length, candidates: plan.candidates.length, write: null, missing: false };
  const write = await writeDiscoveredEdges(deps.sb, [...plan.kept, ...plan.candidates], { candidateSources: [itemId], ...(deps.snapshot ? { snapshot: deps.snapshot } : {}) });
  return { found: plan.kept.length, candidates: plan.candidates.length, write, missing: false };
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
  const plan = await planEdges(deps.sb, targets, corpus, input);
  const all = [...plan.kept, ...plan.candidates];
  const counts: Record<string, number> = { corpus: corpus.length, targets: targets.length, items_with_edges: plan.withEdges, edges_found: plan.kept.length, candidates_found: plan.candidates.length, cross_surface: plan.cross, written: 0, upgraded: 0, candidates_deleted: 0, skipped_established: 0, skipped_foreign_origin: 0, skipped_tombstoned: 0, failed_chunks: 0 };
  if (input.dry || !targets.length) return { counts, outcome: "ok", notes: input.dry ? [...notes, "dry: nothing written"] : notes };
  const w = await writeDiscoveredEdges(deps.sb, all, { candidateSources: targets.map((t) => t.id), ...(deps.snapshot ? { snapshot: deps.snapshot } : {}) });
  Object.assign(counts, { written: w.written, inserted: w.inserted, refreshed: w.refreshed, upgraded: w.upgraded, candidates_deleted: w.candidatesDeleted, skipped_established: w.skippedEstablished, skipped_foreign_origin: w.skippedForeignOrigin, skipped_tombstoned: w.skippedTombstoned, failed_chunks: w.failedChunks });
  return { counts, outcome: w.failedChunks ? "partial" : "ok", notes: [...notes, ...w.notes] };
}
