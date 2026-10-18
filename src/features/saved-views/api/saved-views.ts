// Ported from old_repo/src/components/settings/SavedSearchesSection.tsx (lines 1-120)
// /api/saved-views: a user's saved list views (IMP-064, personal per user, operator ruling 2026-10-16). GET lists the caller's views of one list; POST saves the list's current URL state under a
// name; DELETE removes one. Everything runs on the caller's own client, so the table's RLS (migration 0032) is what keeps a user's views theirs; this file validates and says what failed.
// The stored query is the canonical one (parsed and written back by the list's own url-state), never the caller's string.
import { z } from "zod";

import { isMissingObject } from "@/core/db/absent";
import { dbError, HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { isUuid, parseJson } from "@/core/http/parse";
import { parseListUrl, serializeListUrl } from "@/ui/list-surface/url-state";

export const SAVED_VIEW_SURFACES = ["regulations", "market", "research", "operations", "watchlist"] as const;
export const MAX_VIEWS_PER_SURFACE = 50;
const COLUMNS = "id, surface, name, query, created_at";
const surface = z.enum(SAVED_VIEW_SURFACES);
const createBody = z.object({ surface, name: z.string().trim().min(1, "Give the view a name.").max(60, "A view name is at most 60 characters."), query: z.string().max(1000) });

/** The table is added by a migration the database may not carry yet: that is a stated, retryable state ('not available yet'), never a raw relation error. */
const failure = (error: { message: string; code?: string | null }): HttpError =>
  isMissingObject(error) ? new HttpError(503, "Saved views are not available yet. Your views are untouched; try again later.", { "Retry-After": "60" }) : dbError(error);

/** The list state in a query string, written the way the list writes it; null when it holds nothing a view could restore. */
export function canonicalQuery(raw: string, extraKeys: readonly string[] = []): string | null {
  const text = serializeListUrl(parseListUrl(new URLSearchParams(raw.replace(/^\?/, "")), extraKeys));
  return text || null;
}

export const GET = route("/api/saved-views", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const parsed = surface.safeParse(new URL(request.url).searchParams.get("surface"));
  if (!parsed.success) throw new HttpError(400, "surface must name a list");
  const { data, error } = await auth.client.from("saved_views").select(COLUMNS).eq("user_id", auth.userId).eq("surface", parsed.data).order("created_at", { ascending: false }).order("id", { ascending: true }).limit(MAX_VIEWS_PER_SURFACE);
  if (error) throw failure(error);
  return ok({ ...auth.headers, "Cache-Control": "private, no-store" }, { views: data ?? [] });
});

export const POST = route("/api/saved-views", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const input = await parseJson(request, createBody);
  const query = canonicalQuery(input.query);
  if (!query) throw new HttpError(400, "There is nothing to save yet: choose a filter, a band or a sort first.");
  const held = await auth.client.from("saved_views").select("id", { count: "exact", head: true }).eq("user_id", auth.userId).eq("surface", input.surface);
  if (held.error) throw failure(held.error);
  if ((held.count ?? 0) >= MAX_VIEWS_PER_SURFACE) throw new HttpError(400, `You can keep ${MAX_VIEWS_PER_SURFACE} saved views per list. Delete one to save another.`);
  const { data, error } = await auth.client.from("saved_views").insert({ user_id: auth.userId, surface: input.surface, name: input.name, query }).select(COLUMNS).single();
  if (error) throw error.code === "23505" ? new HttpError(409, "You already have a view with that name.") : failure(error);
  return ok(auth.headers, { view: data }, 201);
});

export const DELETE = route("/api/saved-views", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const id = new URL(request.url).searchParams.get("id");
  if (!isUuid(id)) throw new HttpError(400, "id must be a view id");
  const { data, error } = await auth.client.from("saved_views").delete().eq("id", id).eq("user_id", auth.userId).select("id");
  if (error) throw failure(error);
  if (!data || data.length === 0) throw new HttpError(404, "That view is already gone.");
  return ok(auth.headers, { success: true });
});
