// Ported from old_repo/src/lib/data.ts (lines 440-540)
// Ported from old_repo/src/lib/supabase-server.ts (lines 3210-3251)
// The Regulations list reader: the shared list read (src/features/lists) scoped to the regulatory domain, with each row's uuid attached (the list payload's id is the legacy id where there is one, and
// the workspace tags are keyed by uuid). The workspace's own listing RPC when the caller has a workspace, the public one when not. A failed read says so; it never returns a short list as the list.
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import { isUuid } from "@/core/http/parse";
import { pageSizes, trimRemainder } from "@/core/lists";
import type { Resource } from "@/core/types";
import type { WorkspaceProfile } from "@/core/workspace";
import { readListing, readRemainder, readSurfaceCounts, type ListingRpc } from "@/features/lists";

export const REGULATIONS_DOMAIN = 1;
export type LedgerRow = Resource & { uuid: string | null };
const rpcFor = (orgId: string | null): ListingRpc => (orgId ? "get_workspace_intelligence_listings" : "get_workspace_intelligence_listings_public");

/** Rows with their uuid: the id itself when it is one, else the legacy id's item (one chunked read for the page). A failed lookup throws. */
async function withUuids(db: Db, rows: Resource[]): Promise<LedgerRow[]> {
  const legacy = rows.filter((r) => !isUuid(r.id)).map((r) => r.id);
  const found = await fetchAllByIdChunks(
    legacy,
    async (slice) => {
      const r = await db.from("intelligence_items").select("id, legacy_id").in("legacy_id", slice);
      if (r.error) throw new Error(`legacy id lookup failed: ${r.error.message}`);
      return (r.data ?? []) as Array<{ id: string; legacy_id: string }>;
    },
    { chunk: 100 },
  );
  const byLegacy = new Map(found.map((x) => [x.legacy_id, x.id]));
  return rows.map((r) => ({ ...r, uuid: isUuid(r.id) ? r.id : (byLegacy.get(r.id) ?? null) }));
}

/** The first page of the regulations list (trimmed to what a row draws), the aggregates, and whether more follows. `failed` is true only when a read errored. */
/** `profile` is the workspace profile the page read for its own rail (null: that read failed and the page says so); the rows' client score uses it instead of reading it again. */
export async function readRegulationsFirstPage(db: Db, orgId: string | null, profile?: WorkspaceProfile | null) {
  const [page, aggregates] = await Promise.all([readListing(db, { orgId, rpc: rpcFor(orgId), page: { offset: 0, limit: pageSizes.first, domain: REGULATIONS_DOMAIN }, profile }), readSurfaceCounts(db, orgId, "regulations")]);
  const rows = page.failed ? [] : await withUuids(db, page.rows.filter((r) => r.domain === REGULATIONS_DOMAIN).map(trimRemainder));
  const hasMore = (aggregates?.totalItems ?? rows.length) > rows.length;
  return { rows, aggregates, hasMore, failed: page.failed, enrichFailed: page.enrichFailed, timelineFailures: page.timelineFailures, overridesFailed: page.overrides === null };
}

/** Everything after the first page, trimmed. A failure is reported as one, never as a short list. */
export async function readRegulationsRemainder(db: Db, orgId: string | null): Promise<{ rows: LedgerRow[]; failed: boolean }> {
  const rest = await readRemainder(db, { orgId, rpc: rpcFor(orgId), firstPageSize: pageSizes.first, domain: REGULATIONS_DOMAIN });
  if (rest.failed) return { rows: [], failed: true };
  return { rows: await withUuids(db, rest.rows.filter((r) => r.domain === REGULATIONS_DOMAIN).map(trimRemainder)), failed: false };
}
