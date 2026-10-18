// Ported from old_repo/src/app/api/community/groups/[id]/members/route.ts (lines 5-8)
// Ported from old_repo/src/lib/community/member-pref-route.mjs (lines 1-60)
// Ported from old_repo/src/app/api/community/posts/route.ts (lines 187-219)
// The five steps every Community handler repeated (a uuid check in 17 copies, the caller's group role pre-read, the limit parse, the JSON body, the read that drops its error), once. A read that fails is a 503 the
// client retries (LookupError), never a 403 or a 404.
import { z } from "zod";

import type { Db } from "@/core/db/clients";
import { HttpError, LookupError } from "@/core/http/errors";

import type { GroupRole } from "../lib/types";

type Reply = PromiseLike<{ data: unknown; error: { message: string; code?: string | null } | null }>;

/** One row (or none) of a query; the error is a LookupError (503), the absence is null. */
export async function one<T>(query: Reply, step: string): Promise<T | null> {
  const { data, error } = await query;
  if (error) throw new LookupError(step, error);
  return (data ?? null) as T | null;
}
/** Every row of a bounded query; the error is a LookupError (503). */
export async function many<T>(query: Reply, step: string): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new LookupError(step, error);
  return (data ?? []) as T[];
}

/** An id field in a customer-facing message: the 400 says WHAT was malformed in the reader's words, never the validator's ("Invalid GUID"). */
export const idField = (what: string) => z.guid({ error: `That ${what} is not valid` });

/** The `[id]`-style path parameter, validated as an id (400 with the name of what was asked for). */
export async function idParam(ctx: { params: Promise<Record<string, string>> }, key = "id", what = "id"): Promise<string> {
  const params = await ctx.params;
  const parsed = idField(what).safeParse(params[key]);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? `That ${what} is not valid`);
  return parsed.data;
}

/** A positive integer query parameter capped at `max`; absent is `def`. */
export function limitParam(url: URL, def: number, max: number): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "limit must be a positive integer");
  return Math.min(n, max);
}

/** An ISO timestamp query parameter (a cursor), or null when absent. */
export function cursorParam(url: URL, key: string): string | null {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return null;
  if (Number.isNaN(Date.parse(raw))) throw new HttpError(400, `${key} must be an ISO timestamp`);
  return new Date(raw).toISOString();
}

/** The caller's role in a group: null when they hold none. A failed read throws (503): it is never read as "not a member". */
export async function groupRole(client: Db, groupId: string, userId: string): Promise<GroupRole | null> {
  const row = await one<{ role: GroupRole }>(client.from("community_group_members").select("role").eq("group_id", groupId).eq("user_id", userId).maybeSingle(), "group role");
  return row?.role ?? null;
}

/** The group a caller may see (RLS), or a 404: a private group the caller cannot see answers exactly as a group that does not exist. */
export async function visibleGroup<T extends { id: string }>(client: Db, groupId: string, columns: string): Promise<T> {
  const row = await one<T>(client.from("community_groups").select(columns).eq("id", groupId).maybeSingle(), "group");
  if (!row) throw new HttpError(404, "Group not found");
  return row;
}

/** A write the mute trigger refused: the database's own sentence names the date, and it is the customer's sentence. */
export const mutedSentence = (error: { message: string; code?: string | null }): string | null => (error.code === "42501" && /^You are muted in this group until /.test(error.message) ? error.message : null);

export const isReviewerRole = (role: GroupRole | null): boolean => role === "admin" || role === "moderator";
