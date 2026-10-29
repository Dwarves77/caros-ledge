// Ported from old_repo/src/lib/supabase-server.ts (lines 706-983)
// Ported from old_repo/src/lib/supabase-server.ts (lines 3008-3143)
// Ported from old_repo/src/lib/supabase-server.ts (lines 3210-3251)
// The listing reads over the listing RPCs. A failed read says it failed: `failed` is true only when the RPC errored, an empty corpus is `failed: false`
// with no rows, and no wrapper maps one to the other (INV-263).
import type { Db } from "@/core/db";
import type { ListingCursor } from "@/core/lists";
import type { Resource } from "@/core/types";
import type { WorkspaceProfile } from "@/core/workspace";
import type { WorkspaceOverride } from "@/features/workspace/state";

import { enrichSources } from "./enrich";
import { mapRows, type WorkspaceItemRpcRow } from "./map-rows";

/** Every listing RPC ends its own ORDER BY in id (a total order), so a ranged read never repeats or skips a row at a page boundary. */
export type ListingRpc = "get_workspace_intelligence_listings" | "get_workspace_intelligence_slim" | "get_workspace_intelligence" | "get_workspace_intelligence_dashboard" | "get_workspace_intelligence_listings_public" | "get_workspace_intelligence_slim_public";
const DOMAIN_SCOPED = new Set<string>(["get_workspace_intelligence_listings", "get_workspace_intelligence_listings_public"]);
const CURSOR_SCOPED = new Set<string>(["get_workspace_intelligence_listings_public"]);
const OVERRIDE_CHUNK = 150;

export interface ListingPage {
  offset: number;
  limit: number;
  domain?: number;
  cursor?: ListingCursor;
}
export interface ListingRead {
  rows: Resource[];
  archived: Resource[];
  /** The org's override rows for the rows read (org-scoped reads only); null when that read failed. */
  overrides: WorkspaceOverride[] | null;
  /** The RPC itself failed. False for an honest empty corpus. */
  failed: boolean;
  timelineFailures: number;
  /** The source-rating read failed: rows carry no tier or bias tags, and the surface shows the Absence dash (never an invented tier). */
  enrichFailed: boolean;
  message: string | null;
}

type OverrideDbRow = { item_id: string; priority_override: string | null; is_archived: boolean | null; archive_reason: string | null; archive_note: string | null; archived_at: string | null; dismissed_at: string | null; owner_user_id: string | null };

async function readOverrides(db: Db, orgId: string, uiIds: Map<string, string>): Promise<WorkspaceOverride[] | null> {
  const ids = [...uiIds.keys()];
  const slices = Array.from({ length: Math.ceil(ids.length / OVERRIDE_CHUNK) }, (_, i) => ids.slice(i * OVERRIDE_CHUNK, (i + 1) * OVERRIDE_CHUNK));
  const pages = await Promise.all(slices.map((s) => db.from("workspace_item_overrides").select("item_id, priority_override, is_archived, archive_reason, archive_note, archived_at, dismissed_at, owner_user_id").eq("org_id", orgId).in("item_id", s)));
  if (pages.some((p) => p.error)) return null;
  return pages.flatMap((p) => ((p.data ?? []) as OverrideDbRow[]).map((o) => ({ itemId: uiIds.get(o.item_id) ?? o.item_id, priorityOverride: o.priority_override ?? null, isArchived: !!o.is_archived, archiveReason: o.archive_reason ?? null, archiveNote: o.archive_note ?? null, archivedAt: o.archived_at ?? null, dismissedAt: o.dismissed_at ?? null, ownerUserId: o.owner_user_id ?? null })));
}

/** One page of a listing RPC, org-scoped (p_org_id) or public (keyset cursor), mapped with timelines. */
/** `profile` is the workspace profile the caller has read already (null: it failed and the caller states so); absent, the rows' client score reads it. */
export async function readListing(db: Db, opts: { orgId?: string | null; rpc: ListingRpc; page?: ListingPage; profile?: WorkspaceProfile | null | undefined }): Promise<ListingRead> {
  const { orgId, rpc, page } = opts;
  const args: Record<string, unknown> = orgId ? { p_org_id: orgId } : {};
  if (typeof page?.domain === "number" && DOMAIN_SCOPED.has(rpc)) args.p_domain = page.domain;
  const cursor = page?.cursor;
  const useCursor = CURSOR_SCOPED.has(rpc) && !!cursor?.afterPriority && !!cursor.afterId;
  if (useCursor && cursor) {
    args.p_after_priority = cursor.afterPriority;
    args.p_after_added_date = cursor.afterAddedDate ?? null;
    args.p_after_id = cursor.afterId;
  }
  const call = db.rpc(rpc, args);
  const from = page ? (useCursor ? 0 : page.offset) : 0;
  const { data, error } = await (page ? call.range(from, from + page.limit - 1) : call);
  if (error) return { rows: [], archived: [], overrides: [], failed: true, timelineFailures: 0, enrichFailed: false, message: error.message };
  const items = (data ?? []) as WorkspaceItemRpcRow[];
  if (items.length === 0) return { rows: [], archived: [], overrides: [], failed: false, timelineFailures: 0, enrichFailed: false, message: null };
  const uiIds = new Map(items.map((i) => [i.id, i.legacy_id || i.id]));
  const [mapped, overrides] = await Promise.all([
    mapRows(db, items, { orgId: orgId ?? null, profile: opts.profile }),
    orgId ? readOverrides(db, orgId, uiIds) : Promise.resolve([]),
  ]);
  const enriched = await enrichSources(db, [...mapped.active, ...mapped.archived], { biasTags: true });
  return { rows: mapped.active, archived: mapped.archived, overrides, failed: false, timelineFailures: mapped.timelineFailures, enrichFailed: !enriched, message: null };
}

/**
 * The remainder after the first page, requested explicitly: a failure is a FAILURE for the caller to say, never a short list. With the corpus `total` (the caller's counts read) the pages are read together and concatenated in offset order;
 * the walk then continues from where they end while the last page is full, so a total that is too small drops no row. Without a total the walk is sequential.
 */
export async function readRemainder(db: Db, opts: { orgId?: string | null; rpc: ListingRpc; firstPageSize: number; domain?: number; pageSize?: number; total?: number }): Promise<{ rows: Resource[]; failed: boolean }> {
  const size = opts.pageSize ?? 500;
  const page = (offset: number) => readListing(db, { ...(opts.orgId ? { orgId: opts.orgId } : {}), rpc: opts.rpc, page: { offset, limit: size, ...(opts.domain !== undefined ? { domain: opts.domain } : {}) } });
  const upFront = opts.total === undefined ? 0 : Math.max(0, Math.ceil((opts.total - opts.firstPageSize) / size));
  const pages = await Promise.all(Array.from({ length: upFront }, (_, i) => page(opts.firstPageSize + i * size)));
  const full = (r: ListingRead) => r.rows.length + r.archived.length >= size;
  for (let last = pages.at(-1); !last || full(last); ) {
    last = await page(opts.firstPageSize + pages.length * size);
    pages.push(last);
  }
  return pages.some((p) => p.failed) ? { rows: [], failed: true } : { rows: pages.flatMap((p) => p.rows), failed: false };
}
