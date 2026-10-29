// New file (scripts/ci/new-files/impact-1.txt): the one place a reader gives its rows their impact (IMPACT-1). Every reader that maps rows to Resources (mapRows, readCategory, the detail loader) calls it, so a row's impact is item_impact_scores for that item, and a row with a
// dimension still missing says which input it waits for. The client dimension is the reading workspace's relevance to the item (read-time, never stored); with no workspace it is not known and the row says so.
import { admitItems } from "@/core/derived/admissible";
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import type { Resource } from "@/core/types";
import { readWorkspaceProfile, relevanceForItem, type WorkspaceProfile } from "@/core/workspace";
import { relevanceDeps } from "@/core/workspace/relevance-deps";

import { clientScore, composeImpact, readImpactRows } from "./read";

const TAG_COLUMNS = "id, title, transport_modes, jurisdictions, jurisdiction_iso, topic_tags, operational_scenario_tags, compliance_object_tags";
/** The TAG_COLUMNS values of an item a caller already holds, keyed by item uuid; an entry carries every one of those columns (the score is computed from them as the table read would give them). */
export type ItemTags = ReadonlyMap<string, Record<string, unknown>>;

async function clientScores(db: Db, ids: readonly string[], orgId: string, given: WorkspaceProfile | null | undefined, held: ItemTags): Promise<Map<string, number>> {
  // A caller that has read the profile already passes it (null: it failed, and the caller says so, so no client score is known); otherwise it is read here. A failed profile read gives the default profile, and a client score computed from the
  // default is not the workspace's: it fails the read instead.
  if (given === null) return new Map();
  const missing = ids.filter((id) => !held.has(id));
  const [read, fetched] = await Promise.all([
    given ? Promise.resolve({ profile: given, failed: false }) : readWorkspaceProfile(db, orgId),
    fetchAllByIdChunks<Record<string, unknown> & { id: string }>(missing, async (slice) => {
      const { data, error } = await admitItems(db.from("intelligence_items").select(TAG_COLUMNS)).in("id", slice);
      if (error) throw new Error(`intelligence_items read failed: ${error.message}`);
      return (data ?? []) as (Record<string, unknown> & { id: string })[];
    }, { chunk: 150 }),
  ]);
  if (read.failed) throw new Error("workspace_settings read failed");
  const rows = [...fetched, ...ids.filter((id) => held.has(id)).map((id) => ({ ...held.get(id), id }))];
  return new Map(rows.map((r) => [r.id, clientScore(relevanceForItem(r, read.profile, relevanceDeps))]));
}

/**
 * Give each resource its impact scores or the sentence of the input it waits for. `uuidOf` maps a resource id (the legacy id where there is one) to the item's uuid. `tags` holds the tag columns of items the caller has read already (by uuid): the client score of those is computed from them, and only the others are read. A failed read THROWS, so the list read that called it fails and its page says so
 * (INV-263: a score is never drawn from a partial read, and a failed read is never a row that quietly has none); only the pending-migration state (the table is not there yet) reads as "no score row yet".
 */
export async function attachImpact(db: Db, resources: readonly Resource[], uuidOf: ReadonlyMap<string, string>, orgId: string | null, profile?: WorkspaceProfile | null, tags: ItemTags = new Map()): Promise<void> {
  const ids = [...new Set(uuidOf.values())];
  const [stored, client] = await Promise.all([readImpactRows(db, ids), orgId ? clientScores(db, ids, orgId, profile, tags) : Promise.resolve(new Map<string, number>())]);
  for (const r of resources) {
    const uuid = uuidOf.get(r.id);
    const { scores, absence } = composeImpact(uuid ? stored.get(uuid) : undefined, uuid ? (client.get(uuid) ?? null) : null);
    if (scores) r.impactScores = scores;
    else if (absence) r.impactAbsence = absence;
  }
}
