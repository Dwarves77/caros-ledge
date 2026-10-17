// Ported from old_repo/src/lib/api/route-guard.ts (lines 15-101)
import type { Db } from "@/core/db";
import { HttpError, ok, route } from "@/core/http/errors";
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
  if (error || typeof count !== "number") throw new HttpError(503, `${what} could not be counted${error ? `: ${error.message}` : ""}`, { "Retry-After": "1" });
  return count;
}
