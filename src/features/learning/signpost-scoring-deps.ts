// Ported from old_repo/src/lib/learning/prediction-scoring.mjs (lines 345-488)
// The reads and guarded writes of the signpost step over the service client. Every read throws on a database error (a failed read is never an empty list); a column the
// schema step did not apply is a schema failure, not a runtime branch. Firing is the one transactional database call (fireSignpost).
import { fetchAllByIdChunks, fetchAllRows, type Db } from "@/core/db";
import { fireSignpost } from "@/core/propagation";

import { deadlineMs, type SignpostRow, type SignpostStepDeps } from "./signpost-scoring";

const COLS = "entity_id,assessment_id,watches,predicate,direction,fired_at,outcome,lifecycle_applied_at";
const CAP = 5000;
const ok = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what} failed: ${r.error.message}`);
  return (r.data ?? []) as T;
};

export function buildSignpostStepDeps(sb: Db): SignpostStepDeps {
  const page = (build: (from: number, to: number) => unknown) => fetchAllRows<SignpostRow>(build as never, { cap: CAP });
  return {
    readSignpostsWatching: (ids) => fetchAllByIdChunks(ids, async (slice) => ok(await sb.from("signposts").select(COLS).in("watches", slice).is("fired_at", null).is("outcome", null), "reading signposts") as SignpostRow[], { manyPerId: true }),
    readFiredUnscored: () => page((a, b) => sb.from("signposts").select(COLS).not("fired_at", "is", null).is("outcome", null).order("entity_id", { ascending: true }).range(a, b)),
    readDeadlineCandidates: async () => (await page((a, b) => sb.from("signposts").select(COLS).is("fired_at", null).is("outcome", null).order("entity_id", { ascending: true }).range(a, b))).filter((r) => deadlineMs(r.predicate) !== null),
    readLifecycleUnapplied: () => page((a, b) => sb.from("signposts").select(COLS).not("fired_at", "is", null).is("lifecycle_applied_at", null).order("entity_id", { ascending: true }).range(a, b)),
    async readAssessments(ids) {
      const rows = await fetchAllByIdChunks(ids, async (slice) => ok(await sb.from("research_assessments").select("id,item_id,lifecycle_state").in("id", slice), "reading research_assessments") as Array<{ id: string; item_id: string | null; lifecycle_state: string | null }>);
      return new Map(rows.map((r) => [r.id, { item_id: r.item_id ?? null, lifecycle_state: r.lifecycle_state ?? "emerging" }]));
    },
    async readGroundingSources(itemIds) {
      const rows = await fetchAllByIdChunks(itemIds, async (slice) => ok(await sb.from("section_claim_provenance").select("intelligence_item_id,source_id").in("intelligence_item_id", slice).in("claim_kind", ["FACT", "LEGAL"]).not("source_id", "is", null), "reading section_claim_provenance") as Array<{ intelligence_item_id: string; source_id: string }>, { manyPerId: true });
      const map = new Map<string, string[]>();
      for (const r of rows) map.set(r.intelligence_item_id, [...new Set([...(map.get(r.intelligence_item_id) ?? []), r.source_id])]);
      return map;
    },
    async readLedgerSources(entityId) {
      return (await fetchAllRows<{ source_id: string }>((a, b) => sb.from("source_reliability_ledger").select("source_id").eq("signpost_entity_id", entityId).order("id", { ascending: true }).range(a, b) as never, { cap: CAP })).map((r) => r.source_id);
    },
    fire: async (entityId, now, reason) => void (await fireSignpost(sb, { signpostEntityId: entityId, now, reason })),
    async writeLedger(rows) {
      ok(await sb.from("source_reliability_ledger").insert(rows as never), "writing source_reliability_ledger");
    },
    async scoreSignpost(entityId, patch) {
      ok(await sb.from("signposts").update(patch).eq("entity_id", entityId).is("outcome", null).select("entity_id"), "scoring the signpost");
    },
  };
}

