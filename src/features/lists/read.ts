// Ported from old_repo/src/lib/supabase-server.ts (lines 706-983, 3008-3143, 3210-3251)
// The listing reads over the listing RPCs. A failed read says it failed: `failed` is true only when the RPC errored, an empty corpus is `failed: false`
// with no rows, and no wrapper maps one to the other (INV-263).
import type { Db } from "@/core/db";
import type { ListingCursor } from "@/core/lists";
import type { Resource } from "@/core/types";
import type { WorkspaceOverride } from "@/features/workspace/state";

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
  message: string | null;
}

type OverrideDbRow = { item_id: string; priority_override: string | null; is_archived: boolean | null; archive_reason: string | null; archive_note: string | null; archived_at: string | null; dismissed_at: string | null; owner_user_id: string | null };

async function readOverrides(db: Db, orgId: string, uiIds: Map<string, string>): Promise<WorkspaceOverride[] | null> {
  const out: WorkspaceOverride[] = [];
  const ids = [...uiIds.keys()];
  for (let i = 0; i < ids.length; i += OVERRIDE_CHUNK) {
    const { data, error } = await db.from("workspace_item_overrides").select("item_id, priority_override, is_archived, archive_reason, archive_note, archived_at, dismissed_at, owner_user_id").eq("org_id", orgId).in("item_id", ids.slice(i, i + OVERRIDE_CHUNK));
    if (error) return null;
    for (const o of (data ?? []) as OverrideDbRow[]) {
      out.push({ itemId: uiIds.get(o.item_id) ?? o.item_id, priorityOverride: o.priority_override ?? null, isArchived: !!o.is_archived, archiveReason: o.archive_reason ?? null, archiveNote: o.archive_note ?? null, archivedAt: o.archived_at ?? null, dismissedAt: o.dismissed_at ?? null, ownerUserId: o.owner_user_id ?? null });
    }
  }
  return out;
}

/** One page of a listing RPC, org-scoped (p_org_id) or public (keyset cursor), mapped with timelines. */
export async function readListing(db: Db, opts: { orgId?: string | null; rpc: ListingRpc; page?: ListingPage }): Promise<ListingRead> {
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
  if (error) return { rows: [], archived: [], overrides: [], failed: true, timelineFailures: 0, message: error.message };
  const items = (data ?? []) as WorkspaceItemRpcRow[];
  if (items.length === 0) return { rows: [], archived: [], overrides: [], failed: false, timelineFailures: 0, message: null };
  const mapped = await mapRows(db, items);
  const overrides = orgId ? await readOverrides(db, orgId, mapped.uuidToUiId) : [];
  return { rows: mapped.active, archived: mapped.archived, overrides, failed: false, timelineFailures: mapped.timelineFailures, message: null };
}

/** The remainder after the first page, requested explicitly: a failure is a FAILURE for the caller to say, never a short list. */
export async function readRemainder(db: Db, opts: { orgId?: string | null; rpc: ListingRpc; firstPageSize: number; domain?: number; pageSize?: number }): Promise<{ rows: Resource[]; failed: boolean }> {
  const size = opts.pageSize ?? 500;
  const rows: Resource[] = [];
  for (let offset = opts.firstPageSize; ; offset += size) {
    const r = await readListing(db, { ...(opts.orgId ? { orgId: opts.orgId } : {}), rpc: opts.rpc, page: { offset, limit: size, ...(opts.domain !== undefined ? { domain: opts.domain } : {}) } });
    if (r.failed) return { rows: [], failed: true };
    rows.push(...r.rows);
    if (r.rows.length + r.archived.length < size) return { rows, failed: false };
  }
}
