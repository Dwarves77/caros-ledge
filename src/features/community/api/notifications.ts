// Ported from old_repo/src/app/api/community/notifications/route.ts (lines 7-118)
// Ported from old_repo/src/app/api/community/notifications/[id]/route.ts (lines 42-96)
// Ported from old_repo/src/app/api/community/notifications/counts/route.ts (lines 1-62)
// The platform inbox's routes: the list with its unread count (the shell polls `?unread_only=true&limit=1` for its badge), mark one read, mark all read, and the per-group unread counts as a grouped count in SQL. Every
// read and mark is the recipient's own (row policy plus an explicit user filter); a failed count is a 503, never a zero. The unread-only first page needs no second count: it IS the unread count.
import { z } from "zod";

import { HttpError, LookupError, dbError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";


import { idParam, cursorParam, limitParam, many } from "./_http";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const COLUMNS = "id, kind, payload, read_at, created_at";

export const GET = route("/api/community/notifications", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const url = new URL(request.url);
  const unreadOnly = ["true", "1"].includes(url.searchParams.get("unread_only") ?? "");
  const limit = limitParam(url, DEFAULT_LIMIT, MAX_LIMIT);
  const before = cursorParam(url, "before");
  let query = auth.client.from("notifications").select(COLUMNS, { count: "exact" }).eq("user_id", auth.userId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (unreadOnly) query = query.is("read_at", null);
  if (before) query = query.lt("created_at", before);
  const { data, error, count } = await query;
  if (error) throw new LookupError("notifications", error);
  if (typeof count !== "number") throw new LookupError("notifications", "no count returned");
  const rows = (data ?? []) as Array<{ created_at: string }>;
  const page = rows.slice(0, limit);
  let unread = count;
  if (!unreadOnly || before) {
    const head = await auth.client.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", auth.userId).is("read_at", null);
    if (head.error || typeof head.count !== "number") throw new LookupError("unread count", head.error ?? "no count returned");
    unread = head.count;
  }
  return ok(auth.headers, { notifications: page, total_matching: count, unread_count: unread, next_cursor: rows.length > limit ? (page[page.length - 1]?.created_at ?? null) : null });
});

export const POST = route("/api/community/notifications", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  await parseJson(request, z.object({ action: z.literal("mark_all_read") }));
  const { data, error } = await auth.client.from("notifications").update({ read_at: new Date(performance.timeOrigin + performance.now()).toISOString() }).eq("user_id", auth.userId).is("read_at", null).select("id");
  if (error) throw dbError(error);
  return ok(auth.headers, { ok: true, updated: data?.length ?? 0 });
});

export const POST_ONE = route("/api/community/notifications/[id]", async (request, ctx: { params: Promise<{ id: string }> }) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const id = await idParam(ctx, "id", "notification id");
  await parseJson(request, z.object({ action: z.literal("mark_read") }));
  const { data, error } = await auth.client.from("notifications").update({ read_at: new Date(performance.timeOrigin + performance.now()).toISOString() }).eq("id", id).eq("user_id", auth.userId).select(COLUMNS).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new HttpError(404, "Notification not found");
  return ok(auth.headers, { ok: true, notification: data });
});

export const GET_COUNTS = route("/api/community/notifications/counts", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const rows = await many<{ group_id: string | null; unread_count: number | string }>(auth.client.rpc("community_notification_counts"), "notification counts");
  const groups = rows.filter((r) => r.group_id).map((r) => ({ group_id: r.group_id as string, unread_count: Number(r.unread_count) }));
  return ok(auth.headers, { groups, total_unread: rows.reduce((n, r) => n + Number(r.unread_count), 0) });
});
