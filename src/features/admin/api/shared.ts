// Ported from old_repo/src/lib/api/route-guard.ts (lines 15-101)
import { z } from "zod";

import { isMissingObject } from "@/core/db/absent";
import type { Db } from "@/core/db";
import { dbError, HttpError, LOOKUP_SENTENCE, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireAdmin, type AdminContext } from "@/core/http/guard";

export type { AdminContext };

/** One admin handler: the platform-admin guard first (a refusal is returned as it is), then the handler with the admin context. Every /api/admin route is built with this. */
export function adminRoute<Ctx = unknown>(name: string, handler: (admin: AdminContext, request: Request, ctx: Ctx) => Promise<Response>) {
  return route<Ctx>(name, async (request, ctx) => {
    const admin = await requireAdmin(request);
    return isRefusal(admin) ? admin : handler(admin, request, ctx);
  });
}

/** A success body with the caller's rate-limit headers. */
export const reply = (admin: AdminContext, body: unknown, status = 200, extra: Record<string, string> = {}): Response => ok({ ...admin.headers, ...extra }, body, status);

/** The first `limit` of a query-string number, clamped; absent or unreadable means `fallback`. */
export function boundedInt(raw: string | null, fallback: number, max: number): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : fallback;
}

/** A trimmed non-empty string, or null. */
export const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** One checked source_trust_events row naming the actor (INV-288): a failed write throws, it is never skipped. `human` is the check-constrained actor class of an operator. */
export async function writeTrustEvent(db: Db, e: { sourceId: string; type: "tier_override" | "tier_override_revert" | "manual_review"; details: Record<string, unknown>; actorId: string }): Promise<void> {
  const { error } = await db.from("source_trust_events").insert({ source_id: e.sourceId, event_type: e.type, details: e.details, created_by: "human", reviewer_id: e.actorId });
  if (error) throw new HttpError(500, `the audit row was not written: ${error.message}`);
}

/** The count of a head query, or an honest failure (never a zero for an unreadable count). */
export async function headCount(q: PromiseLike<{ count: number | null; error: { message: string } | null }>, what: string): Promise<number> {
  const { count, error } = await q;
  if (error || typeof count !== "number") throw new HttpError(503, `${what} could not be counted${error ? `: ${error.message}` : ""}`, { "Retry-After": "1" }, LOOKUP_SENTENCE);
  return count;
}

/** The stated block for a function a pending migration adds: a 503 that names the function and the migration, not a thrown page and not a zero. */
export const notInstalled = (fn: string, migration: string): HttpError => new HttpError(503, `${fn} is not installed on this database yet (migration ${migration} has not been applied here)`);

/** The operator's own reason for an act, required and bounded (the database function refuses a blank one too). */
export const reasonOf = z.string().trim().min(1, "A reason is required: say why in your own words.").max(2000, "A reason is at most 2000 characters.");

/** The refusals an admin function writes for the operator (not allowed, not found, a rule it keeps); anything else is a failed write answered 503 with the driver text in the log. */
const OWN_REFUSALS = new Set(["42501", "P0002", "22023"]);

/**
 * One admin act: a database function (migration 0102) called on the admin's OWN client, so the actor is the session, a platform-admin check runs inside it as well as in the guard, and the change and its admin_events row are one
 * transaction. A function a pending migration adds is the stated block, not a thrown page.
 */
export async function adminAct<T = Record<string, unknown>>(admin: AdminContext, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.client.rpc(fn, args);
  if (isMissingObject(error)) throw notInstalled(fn, "0102");
  if (error) throw OWN_REFUSALS.has(error.code ?? "") ? dbError(error) : new LookupError(fn, error);
  return data as T;
}
