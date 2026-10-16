// Ported from old_repo/src/app/api/workspace/personal-state/route.ts (lines 48-217)
// Ported from old_repo/src/app/api/workspace/bootstrap/logic.ts (lines 38-70)
import { z } from "zod";

import { currentMembership } from "@/core/auth/membership";
import { serviceClient, type Db } from "@/core/db/clients";
import { fetchAllRows } from "@/core/db/query";
import { dbError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";
import { log } from "@/core/shared/log";

import { workspaceDeps } from "./deps";
import { itemUuidOr404 } from "./shared";

// The user_item_state writer and reader (dual-scope archive, migration 235). A PERSONAL archive hides an item for the calling user only,
// so it is deliberately ungated: no role, no reason, no notification. Every write is scoped to the session user's own row; the body
// never names a user (INV-166, INV-165).
export interface PersonalStateItem {
  itemId: string;
  legacyId: string | null;
  title: string | null;
  isArchived: boolean;
  archiveNote: string | null;
  archivedAt: string | null;
}

type Embedded = { legacy_id: string | null; title: string | null };
type Row = { item_id: string; is_archived: boolean; archive_note: string | null; archived_at: string | null; intelligence_items?: Embedded | Embedded[] | null };

const PERSONAL_CAP = 2000;

/**
 * The caller's personally archived items. The one loader the GET route and the bootstrap bundle share; a failed read throws
 * LookupError, it is never an empty list.
 */
export async function loadPersonalState(client: Db, userId: string): Promise<PersonalStateItem[]> {
  let rows: Row[];
  try {
    rows = (await fetchAllRows(
      (from, to) =>
        client
          .from("user_item_state")
          .select("item_id, is_archived, archive_note, archived_at, intelligence_items(legacy_id, title)")
          .eq("user_id", userId)
          .eq("is_archived", true)
          .order("archived_at", { ascending: false })
          .order("item_id", { ascending: true })
          .range(from, to),
      { cap: PERSONAL_CAP },
    )) as unknown as Row[];
  } catch (e) {
    throw new LookupError("user_item_state", e);
  }
  return rows.map((r) => {
    const embedded = Array.isArray(r.intelligence_items) ? r.intelligence_items[0] : r.intelligence_items;
    return { itemId: r.item_id, legacyId: embedded?.legacy_id ?? null, title: embedded?.title ?? null, isArchived: r.is_archived, archiveNote: r.archive_note, archivedAt: r.archived_at };
  });
}

const postBody = z.looseObject({ itemId: z.string().min(1), isArchived: z.boolean(), archiveNote: z.string().nullable().optional() });
const deleteBody = z.object({ itemId: z.string().min(1) });

export const GET = route("/api/workspace/personal-state", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  return ok(auth.headers, { items: await loadPersonalState(serviceClient(), auth.userId) });
});

export const POST = route("/api/workspace/personal-state", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const input = await parseJson(request, postBody);
  const service = serviceClient();
  const itemUuid = await itemUuidOr404(service, input.itemId);
  // org_id is contextual metadata (nullable by schema): a failed resolution never blocks the write, and is logged.
  let orgId: string | null = null;
  try {
    orgId = (await currentMembership(auth.client, auth.userId))?.orgId ?? null;
  } catch (e) {
    log.warn("[personal-state] org not resolved, writing without it:", e instanceof Error ? e.message : String(e));
  }
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { user_id: auth.userId, org_id: orgId, item_id: itemUuid, is_archived: input.isArchived, archived_at: input.isArchived ? now : null, updated_at: now };
  // A note is optional on a personal archive and cleared on restore.
  if (input.archiveNote !== undefined || !input.isArchived) update.archive_note = input.isArchived && typeof input.archiveNote === "string" ? input.archiveNote : null;
  const { data, error } = await service.from("user_item_state").upsert(update, { onConflict: "user_id,item_id" }).select().single();
  if (error) throw dbError(error);
  workspaceDeps().revalidateWorkspaceData?.();
  return ok(auth.headers, { state: data });
});

export const DELETE = route("/api/workspace/personal-state", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const input = await parseJson(request, deleteBody);
  const service = serviceClient();
  const itemUuid = await itemUuidOr404(service, input.itemId);
  const { error } = await service.from("user_item_state").delete().eq("user_id", auth.userId).eq("item_id", itemUuid);
  if (error) throw dbError(error);
  workspaceDeps().revalidateWorkspaceData?.();
  return ok(auth.headers, { success: true });
});
