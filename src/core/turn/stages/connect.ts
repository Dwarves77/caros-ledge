// Ported from old_repo/scripts/turns/run-population-flywheel.mjs (lines 522-710)
// Ported from old_repo/scripts/turns/run-population-flywheel.mjs (lines 966-1294)
// Stage 6, connect: the flywheel over the slice the intake stage minted AND any earlier slice nothing ever connected (read from the ledger). Order: tags first, so discovery and the corpus pass see them;
// then discovery for the slice, the term pass, the corpus pass, and last the reading of the backlog: every verified item not yet read at the current versions has its source text extracted and its obligations derived, oldest first, a bounded number per
// turn (IMPACT-1; the propagate stage behind scores what was read); last, every pending regulatory trigger a later capture now states is resolved (FLY-1, ADR-050). A slice whose ids are gone refuses; the stage never writes a zero outcome over it.
import { edgeSnapshotSink } from "@/core/flywheel/edges";
import { runPatterns } from "@/core/flywheel/patterns";
import type { FamilyCall } from "@/core/harness";
import type { RunResult } from "@/core/types/run-result";
import { leadWithFailures, runResult, worst } from "@/core/types/run-result";
import { READING } from "@/core/impact/rules";
import { corpusPass, discoverForItems, tagPass, termPass } from "@/features/flywheel";
import { resolvePendingTriggers, scanBacklog } from "@/features/obligations";

import { readSliceState } from "../gate";
import type { BuiltDeps } from "../wiring";

const WRITTEN = /(written|inserted|minted|raised|closed)$/;
const sumWritten = (counts: Record<string, number>): number => Object.entries(counts).reduce((n, [k, v]) => n + (WRITTEN.test(k) && Number.isFinite(v) ? v : 0), 0);

/** The slice to connect: what the upstream handed over plus the backlog. Pure. */
function planConnect(upstreamIds: readonly string[], backlog: readonly string[], input: Record<string, unknown>): { ids: string[]; corpus: boolean } {
  const own = Array.isArray(input.ids) ? input.ids.filter((x): x is string => typeof x === "string") : [];
  const ids = [...new Set([...upstreamIds, ...backlog, ...own])];
  return { ids, corpus: ids.length > 0 || input.corpus === true };
}

/** The passes' results become one: counts namespaced by pass (the scan's own counts are the stage's: extracted, derived, refused), the outcome the worst, the connected and scanned ids the hand-off to propagate. Pure. */
export function shapeConnect(ids: readonly string[], parts: { tag: RunResult | null; discovery: RunResult | null; term: RunResult | null; corpus: RunResult | null; patterns?: RunResult | null; scan?: RunResult<{ ids: { scanned_item_ids: string[] } }> | null; triggers?: RunResult | null }): RunResult {
  const list = Object.values(parts).filter((p): p is RunResult => p !== null && p !== undefined);
  const outcome = worst("ok", ...list.map((p) => p.outcome));
  const counts: Record<string, number> = {
    slice: ids.length, connected: outcome === "failed" ? 0 : ids.length, tag_items_written: parts.tag?.counts.items_written ?? 0,
    edges_written: (parts.discovery?.counts.written ?? 0) + (parts.corpus?.counts.intersection_inserted ?? 0) + (parts.corpus?.counts.shared_entity_written ?? 0),
    term_writes: parts.term ? sumWritten(parts.term.counts) : 0, themes: parts.corpus?.counts.themes ?? 0, ...(parts.patterns?.counts ?? {}), ...(parts.scan?.counts ?? {}), ...Object.fromEntries(Object.entries(parts.triggers?.counts ?? {}).map(([k, n]) => [`triggers_${k}`, n])),
  };
  return { ...runResult(outcome, counts, leadWithFailures(list)), data: { ids: { connected_item_ids: outcome === "failed" ? [] : [...ids], scanned_item_ids: parts.scan?.data?.ids.scanned_item_ids ?? [] } } };
}

export async function runConnect(call: FamilyCall, d: BuiltDeps): Promise<RunResult> {
  let state;
  try {
    state = await readSliceState(d.sb);
  } catch (e) {
    return runResult("failed", { refused: 1 }, [`THE GATE could not read the ledger (${e instanceof Error ? e.message : String(e)}): refusing`]);
  }
  if (state.unrecoverable.length) return runResult("failed", { refused: 1 }, [`refusing: ${state.unrecoverable.length} apply run(s) minted items but carry no recoverable ids (${state.unrecoverable.map((u) => `${u.family} ${u.runId} minted ${u.minted}`).join("; ")}); a slice without ids is resolved by hand, never connected with a zero outcome`]);
  const { ids, corpus } = planConnect(call.upstream?.ids.minted_item_ids ?? [], state.unconnected, call.input);
  const deps = { sb: d.sb, now: d.now };
  // The prior state of every edge the passes overwrite is stored under THIS run before the overwrite (IMP-047); the run's row exists before the stage starts.
  const snap = { ...deps, snapshot: edgeSnapshotSink(d.sb, call.runId) };
  const tag = ids.length ? await tagPass(deps, { ids, dry: call.dry, discover: false }) : null;
  const discovery = ids.length ? await discoverForItems(snap, { ids, dry: call.dry }) : null;
  const term = corpus ? await termPass(deps, { dry: call.dry }) : null;
  const pass = corpus ? await corpusPass(snap, { dry: call.dry }) : null;
  // the five pattern detectors run every turn after the corpus pass (CONNECT-2): the joined input is read from the spine the propagate stage's seed and ref passes keep
  const patterns = await runPatterns(deps, { dry: call.dry });
  const scan = await scanBacklog(deps, { dry: call.dry, sliceIds: ids, limit: typeof call.input.scan_limit === "number" ? call.input.scan_limit : READING.backlog.scanPerTurn });
  const triggers = await resolvePendingTriggers(deps, { dry: call.dry });
  return shapeConnect(ids, { tag, discovery, term, corpus: pass, patterns, scan, triggers });
}
