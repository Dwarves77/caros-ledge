// Ported from old_repo/src/app/api/watchlist/route.ts (lines 39-109)
// Ported from old_repo/src/app/api/watchlist/route.ts (lines 122-217)
// Ported from old_repo/src/app/api/watchlist/route.ts (lines 222-360)
import { z } from "zod";

import type { Db } from "@/core/db/clients";
import { currentMembership } from "@/core/auth/membership";
import { dbError, HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";
import { canWrite } from "@/core/workspace";

import { isTeamOnlyScopeViolation, isWatchType, WATCH_TYPES, type WatchlistItemType, type WatchlistScope } from "../links";

// /api/watchlist: the caller's personal list and the workspace's team list, one vocabulary (six types, two scopes) on the caller's own client, so row security decides what each scope may touch.
// GET ?item_type= lists the watched ids of a type (both scopes); GET ?item_type=&item_id= answers one item. POST { itemType, itemId, scope?, note? } watches; DELETE ?item_type=&item_id=&scope= unwatches.
// Any member may add or remove a TEAM watch (the Bloomberg pattern: the first adder is kept); a viewer reads and does not write the team list (SEC-3b); a series is team-scope only (WO-23).
const NAME = "/api/watchlist";
const NOTE_MAX = 280;
const TYPES_HINT = WATCH_TYPES.join("|");
const bad = () => new HttpError(400, `item_type (${TYPES_HINT}) and item_id are required; scope, when given, must be personal|team`);
const body = z.object({ itemType: z.unknown(), itemId: z.unknown(), scope: z.unknown().optional(), note: z.unknown().optional() });

interface Watch {
  itemType: WatchlistItemType;
  itemId: string;
  scope: WatchlistScope;
}
function readWatch(itemType: unknown, itemId: unknown, scope: unknown = "personal"): Watch {
  const id = typeof itemId === "string" ? itemId.trim() : "";
  if (!isWatchType(itemType) || !id || (scope !== "personal" && scope !== "team")) throw bad();
  if (isTeamOnlyScopeViolation(itemType, scope)) throw new HttpError(400, `item_type "${itemType}" is only watchable at scope=team; personal watching of ${itemType} is not supported`);
  return { itemType, itemId: id, scope };
}

/** The caller's workspace and whether they may write its team list; a failed lookup is a 503, never "no workspace". */
async function workspaceOf(client: Db, userId: string): Promise<{ orgId: string | null; canWriteTeam: boolean }> {
  const m = await currentMembership(client, userId);
  return { orgId: m?.orgId ?? null, canWriteTeam: !!m && canWrite(m.role) };
}
async function teamWriter(client: Db, userId: string): Promise<string> {
  const w = await workspaceOf(client, userId);
  if (!w.orgId) throw new HttpError(403, "No organization membership resolved for this user; team scope unavailable");
  if (!w.canWriteTeam) throw new HttpError(403, "viewer_read_only");
  return w.orgId;
}
const must = <T,>(r: { data: T | null; error: { message: string; code?: string | null } | null }, step: string): T | null => {
  if (r.error) throw new LookupError(step, r.error);
  return r.data;
};

export const GET = route(NAME, async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const params = new URL(request.url).searchParams;
  const itemType = params.get("item_type") ?? "";
  const itemId = params.get("item_id");
  if (!isWatchType(itemType) || (itemId !== null && !itemId.trim())) throw bad();
  const w = await workspaceOf(auth.client, auth.userId);
  const mine = auth.client.from("user_watchlist").select("item_id").eq("user_id", auth.userId).eq("item_type", itemType);
  const theirs = w.orgId ? auth.client.from("org_watchlist").select("item_id").eq("org_id", w.orgId).eq("item_type", itemType) : null;
  const [personal, team] = await Promise.all([itemId ? mine.eq("item_id", itemId.trim()) : mine, theirs ? (itemId ? theirs.eq("item_id", itemId.trim()) : theirs) : Promise.resolve({ data: [] as { item_id: string }[], error: null })]);
  const personalIds = (must(personal, "user_watchlist") ?? []).map((r) => r.item_id as string);
  const teamIds = (must(team, "org_watchlist") ?? []).map((r) => r.item_id as string);
  if (itemId) return ok(auth.headers, { watched: personalIds.length > 0, personal: personalIds.length > 0, team: teamIds.length > 0, teamAvailable: w.canWriteTeam });
  return ok(auth.headers, { watchedIds: personalIds, teamWatchedIds: teamIds, teamAvailable: w.canWriteTeam });
});

export const POST = route(NAME, async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const input = await parseJson(request, body);
  const watch = readWatch(input.itemType, input.itemId, input.scope);
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > NOTE_MAX) throw new HttpError(400, `note must be ${NOTE_MAX} characters or fewer`);
  if (watch.scope === "team") {
    const orgId = await teamWriter(auth.client, auth.userId);
    const { error } = await auth.client.from("org_watchlist").upsert({ org_id: orgId, added_by_user_id: auth.userId, item_type: watch.itemType, item_id: watch.itemId, note: note || null }, { onConflict: "org_id,item_type,item_id", ignoreDuplicates: true });
    if (error) throw dbError(error);
  } else {
    const { error } = await auth.client.from("user_watchlist").upsert({ user_id: auth.userId, item_type: watch.itemType, item_id: watch.itemId }, { onConflict: "user_id,item_type,item_id", ignoreDuplicates: true });
    if (error) throw dbError(error);
  }
  return ok(auth.headers, { watched: true, scope: watch.scope });
});

export const DELETE = route(NAME, async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const params = new URL(request.url).searchParams;
  const watch = readWatch(params.get("item_type"), params.get("item_id"), params.get("scope") ?? "personal");
  if (watch.scope === "team") {
    const orgId = await teamWriter(auth.client, auth.userId);
    const { error } = await auth.client.from("org_watchlist").delete().eq("org_id", orgId).eq("item_type", watch.itemType).eq("item_id", watch.itemId);
    if (error) throw dbError(error);
  } else {
    const { error } = await auth.client.from("user_watchlist").delete().eq("user_id", auth.userId).eq("item_type", watch.itemType).eq("item_id", watch.itemId);
    if (error) throw dbError(error);
  }
  return ok(auth.headers, { watched: false, scope: watch.scope });
});
