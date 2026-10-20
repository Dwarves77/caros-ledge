// New file (scripts/ci/new-files/impact-1.txt): the one place a list reader gives its rows their impact (IMPACT-1). Every reader that maps rows to Resources (mapRows, readCategory) calls it, so a row's impact is item_impact_scores for that item, and a row with a
// dimension still missing says which input it waits for. The client dimension is the reading workspace's relevance to the item (read-time, never stored); with no workspace it is not known and the row says so.
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import { clientScore, composeImpact, readImpactRows } from "@/core/impact/read";
import type { Resource } from "@/core/types";
import { readWorkspaceProfile, relevanceForItem, type WorkspaceProfile } from "@/core/workspace";
import { relevanceDeps } from "@/core/workspace/relevance-deps";

const TAG_COLUMNS = "id, title, transport_modes, jurisdictions, jurisdiction_iso, topic_tags, operational_scenario_tags, compliance_object_tags";

async function clientScores(db: Db, ids: readonly string[], orgId: string, given: WorkspaceProfile | null | undefined): Promise<Map<string, number>> {
  // A caller that has read the profile already passes it (null: it failed, and the caller says so, so no client score is known); otherwise it is read here. A failed profile read gives the default profile, and a client score computed from the
  // default is not the workspace's: it fails the read instead.
  if (given === null) return new Map();
  const read = given ? { profile: given, failed: false } : await readWorkspaceProfile(db, orgId);
  if (read.failed) throw new Error("workspace_settings read failed");
  const profile = read.profile;
  const rows = await fetchAllByIdChunks<Record<string, unknown> & { id: string }>(ids, async (slice) => {
    const { data, error } = await db.from("intelligence_items").select(TAG_COLUMNS).in("id", slice);
    if (error) throw new Error(`intelligence_items read failed: ${error.message}`);
    return (data ?? []) as (Record<string, unknown> & { id: string })[];
  }, { chunk: 150 });
  return new Map(rows.map((r) => [r.id, clientScore(relevanceForItem(r, profile, relevanceDeps))]));
}

/**
 * Give each resource its impact scores or the sentence of the input it waits for. `uuidOf` maps a resource id (the legacy id where there is one) to the item's uuid. A failed read THROWS, so the list read that called it fails and its page says so
 * (INV-263: a score is never drawn from a partial read, and a failed read is never a row that quietly has none); only the pending-migration state (the table is not there yet) reads as "no score row yet".
 */
export async function attachImpact(db: Db, resources: readonly Resource[], uuidOf: ReadonlyMap<string, string>, orgId: string | null, profile?: WorkspaceProfile | null): Promise<void> {
  const ids = [...new Set(uuidOf.values())];
  const stored = await readImpactRows(db, ids);
  const client = orgId ? await clientScores(db, ids, orgId, profile) : new Map<string, number>();
  for (const r of resources) {
    const uuid = uuidOf.get(r.id);
    const { scores, absence } = composeImpact(uuid ? stored.get(uuid) : undefined, uuid ? (client.get(uuid) ?? null) : null);
    if (scores) r.impactScores = scores;
    else if (absence) r.impactAbsence = absence;
  }
}
