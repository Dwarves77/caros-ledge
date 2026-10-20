// New file (scripts/ci/new-files/impact-1.txt): the propagate stage's scoring step. The items whose inputs changed since their score was computed (and every item on the first run) are scored by the registered method and stored in item_impact_scores,
// the items the connect stage just read first, then the backlog oldest first, at most READING.backlog.scorePerTurn per turn. The method is pure; this file reads its inputs and writes its rows. Dry computes the same scores and writes nothing.
import { DUTY_HOLDER_CLASSES } from "@/core/contracts/vocabularies";
import { fetchAllByIdChunks, fetchAllRows, type Db } from "@/core/db";
import { authorityFloorFor } from "@/core/grounding/pool";
import { IMPACT_METHOD_ID, IMPACT_METHOD_VERSION, type MethodRegistry } from "@/core/propagation/methods";
import { customerTierOf } from "@/core/sources";
import type { RunResult } from "@/core/types/run-result";
import { currentObligationObjects } from "@/core/workspace";

import { READING } from "./rules";
import type { ImpactObject } from "./score";

const IMPACT_METHOD_KEY = `${IMPACT_METHOD_ID}@${IMPACT_METHOD_VERSION}`;
const CHUNK = 100;
const HOLDER_ROLES = Object.fromEntries(Object.values(DUTY_HOLDER_CLASSES).map((c) => [c.code, c.orgRoles ?? []]));

interface ItemRow {
  id: string;
  updated_at: string;
}
interface ScoreRow {
  item_id: string;
  computed_at: string;
  method_version: string;
}
interface ScanRow {
  item_id: string;
  scanned_at: string;
}

/** The items to score, never-scored first and then the longest-waiting: no score, another method version, or the item or its reading changed after the score was computed. Pure. */
function staleScores(items: readonly ItemRow[], scores: readonly ScoreRow[], scans: readonly ScanRow[]): string[] {
  const score = new Map(scores.map((s) => [s.item_id, s]));
  const scan = new Map(scans.map((s) => [s.item_id, s]));
  const stale = items.filter((i) => {
    const s = score.get(i.id);
    return !s || s.method_version !== IMPACT_METHOD_KEY || s.computed_at < i.updated_at || s.computed_at < (scan.get(i.id)?.scanned_at ?? "");
  });
  return stale.sort((a, b) => (score.get(a.id)?.computed_at ?? "").localeCompare(score.get(b.id)?.computed_at ?? "") || a.id.localeCompare(b.id)).map((i) => i.id);
}

const failure = (what: string, error: { message: string } | null): void => {
  if (error) throw new Error(`${what} read failed: ${error.message}`);
};

/** Score these items (the connect stage's reading first, then the backlog) and store the scores. A failed read throws: no item is scored from a partial input. */
export async function scoreItems(deps: { sb: Db; now: () => Date; registry: MethodRegistry }, input: { dry: boolean; readIds: readonly string[]; limit?: number }): Promise<RunResult<{ ids: { scored_item_ids: string[] } }>> {
  const { sb } = deps;
  const method = deps.registry.get("item_impact_scores", IMPACT_METHOD_ID, IMPACT_METHOD_VERSION);
  if (!method) throw new Error(`the registry holds no ${IMPACT_METHOD_KEY}`);
  const items = await fetchAllRows<ItemRow>((from, to) => sb.from("intelligence_items").select("id, updated_at").eq("provenance_status", "verified").eq("is_archived", false).order("id", { ascending: true }).range(from, to), { cap: 100_000 });
  const scores = await fetchAllRows<ScoreRow>((from, to) => sb.from("item_impact_scores").select("item_id, computed_at, method_version").order("item_id", { ascending: true }).range(from, to), { cap: 100_000 });
  const scans = await fetchAllRows<ScanRow>((from, to) => sb.from("item_obligation_scan").select("item_id, scanned_at").order("item_id", { ascending: true }).range(from, to), { cap: 100_000 });
  const live = new Set(items.map((i) => i.id));
  const first = input.readIds.filter((id) => live.has(id));
  const stale = staleScores(items, scores, scans).filter((id) => !first.includes(id));
  const ids = [...first, ...stale.slice(0, input.limit ?? READING.backlog.scorePerTurn)];
  const examined = new Set(scans.map((s) => s.item_id));
  const counts: Record<string, number> = { impact_scored: 0, impact_backlog: stale.length, impact_backlog_left: Math.max(0, stale.length - (ids.length - first.length)), impact_missing_obligations: 0, impact_missing_cost: 0, impact_missing_operational: 0 };
  const today = deps.now().toISOString().slice(0, 10);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const read = <T>(table: string, columns: string, key: string, chunk = slice) =>
      fetchAllByIdChunks<T>(chunk, async (part) => {
        const { data, error } = await sb.from(table).select(columns).in(key, part);
        failure(table, error);
        return (data ?? []) as T[];
      }, { chunk: 50, manyPerId: true });
    const itemRows = await read<{ id: string; item_type: string | null; source_id: string | null; transport_modes: string[] | null; operational_scenario_tags: string[] | null; cost_mechanism: string | null; penalty_range: string | null }>("intelligence_items", "id, item_type, source_id, transport_modes, operational_scenario_tags, cost_mechanism, penalty_range", "id");
    const sourceIds = [...new Set(itemRows.map((r) => r.source_id).filter((s): s is string => !!s))];
    const sources = await read<{ id: string; base_tier: number | null; effective_tier: number | null; tier_override: number | null }>("sources", "id, base_tier, effective_tier, tier_override", "id", sourceIds);
    const objects = await read<ImpactObject & { instrument_item_id: string; supersedes: string | null }>("obligation_objects", "obligation_id, instrument_item_id, supersedes, binding_position, duty_holder_class, entry_into_force, date_of_application, first_deadline, sanction_class, statutory_maximum, direct_compliance_cost", "instrument_item_id");
    const current = currentObligationObjects<ImpactObject & { instrument_item_id: string; supersedes: string | null }>(objects);
    const computations = await read<{ computation_id: string; obligation_id: string }>("statutory_computations", "computation_id, obligation_id", "obligation_id", current.map((o) => o.obligation_id));
    for (const item of itemRows) {
      const own = current.filter((o) => o.instrument_item_id === item.id);
      const own_ids = new Set(own.map((o) => o.obligation_id));
      const tier = customerTierOf(sources.find((s) => s.id === item.source_id));
      const score = method({
        today, examined: examined.has(item.id), objects: own, computations: computations.filter((c) => own_ids.has(c.obligation_id)).map((c) => c.computation_id),
        item: { transport_modes: item.transport_modes ?? [], operational_scenario_tags: item.operational_scenario_tags ?? [], cost_mechanism: item.cost_mechanism, penalty_range: item.penalty_range },
        sourceTier: tier, floorTier: authorityFloorFor(item.item_type), holderRoles: HOLDER_ROLES,
      });
      for (const m of score.missing) counts[`impact_missing_${m}`] = (counts[`impact_missing_${m}`] ?? 0) + 1;
      rows.push({ item_id: item.id, cost: score.cost, compliance: score.compliance, operational: score.operational, basis: score.basis, missing: score.missing, method_version: IMPACT_METHOD_KEY, computed_at: deps.now().toISOString() });
    }
  }
  counts.impact_scored = rows.length;
  const notes: string[] = [];
  if (!input.dry) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await sb.from("item_impact_scores").upsert(rows.slice(i, i + CHUNK), { onConflict: "item_id" });
      if (error) throw new Error(`item_impact_scores upsert failed: ${error.message}`);
    }
  } else notes.push("dry: nothing written");
  return { counts, outcome: "ok", notes, data: { ids: { scored_item_ids: rows.map((r) => String(r.item_id)) } } };
}
