// Ported from old_repo/src/lib/api/auth.ts (lines 69-132)
// Ported from old_repo/src/lib/api/community-auth.ts (lines 43-98)
// Ported from old_repo/src/lib/api/route-guard.ts (lines 15-101)
// Ported from old_repo/src/lib/api/worker-auth.ts (lines 4-57)
import { timingSafeEqual } from "node:crypto";

import { getClaims } from "@/core/auth/claims";
import { currentMembership, ROLE_RANK } from "@/core/auth/membership";
import { readOwnPlatformAdmin } from "@/core/auth/platform-admin";
import { bearerToken, isSupabaseConfigured, serviceClient, userClient, type Db } from "@/core/db/clients";
import { log } from "@/core/shared/log";
import type { OrgMembership, OrgRole } from "@/core/types";

import { answer, HttpError, refuse } from "./errors";
import { checkRateLimit, hostScopedKey, rateLimitHeaders } from "./rate-limit";

/** A guard answered with a refusal (401, 403, 429, 500, 503) instead of a context. */
export function isRefusal<T>(result: T | Response): result is Response {
  return result instanceof Response;
}

export interface UserContext {
  userId: string;
  email: string | null;
  /** The caller's RLS-bound client. */
  client: Db;
  /** Rate-limit headers for the success response. */
  headers: Record<string, string>;
}
export interface AdminContext extends UserContext {
  /** The service client, handed out only to routes that write. */
  service: () => Db;
}
export interface OrgContext extends UserContext {
  membership: OrgMembership;
}

/** A guard read that failed is its own status (503 for a lookup, never a 401 or 403); anything else is an unexpected 500. */
const failed = (e: unknown): Response => {
  log.warn("[guard] a guard read failed:", e instanceof Error ? e.message : String(e));
  return e instanceof HttpError ? answer(e) : refuse(500, "Authentication failed");
};

/** One guard for every route: cookie or bearer, claims verified locally, then the per-user rate limit. A failed read is a 503, never a 401 or a 403. */
export async function requireUser(request: Request): Promise<UserContext | Response> {
  if (!isSupabaseConfigured()) return refuse(500, "Authentication service not configured");
  try {
    const client = await userClient(request);
    const claims = await getClaims(client, bearerToken(request) ?? undefined);
    if (!claims) return refuse(401, bearerToken(request) ? "Invalid or expired token" : "Authentication required");
    const key = hostScopedKey(claims.userId, request);
    const limited = await checkRateLimit(key);
    if (limited) return limited;
    return { userId: claims.userId, email: claims.email, client, headers: rateLimitHeaders(key) };
  } catch (e) {
    return failed(e);
  }
}

/** The admin console's service client; a deployment without the key answers 503 with the reason, never an unhandled 500 (the member pages never come here). */
function adminServiceClient(): Db {
  try {
    return serviceClient();
  } catch (e) {
    log.warn("[guard] the admin console has no service client:", e instanceof Error ? e.message : String(e));
    throw new HttpError(503, "The admin console is unavailable here: the server's service key is not configured.");
  }
}

/** Platform admin only, decided by the caller's own-row rpc on their own client (no service client needed to ask). */
export async function requireAdmin(request: Request): Promise<AdminContext | Response> {
  const user = await requireUser(request);
  if (isRefusal(user)) return user;
  try {
    if (!(await readOwnPlatformAdmin(user.client))) return refuse(403, "Platform admin access required");
  } catch (e) {
    return failed(e);
  }
  return { ...user, service: adminServiceClient };
}

/** The caller must hold at least `minimum` in `orgId`, or in their active organisation (the oldest membership) when omitted. A viewer is read-only. */
export async function requireOrgRole(request: Request, minimum: OrgRole, orgId?: string): Promise<OrgContext | Response> {
  const user = await requireUser(request);
  if (isRefusal(user)) return user;
  let membership: OrgMembership | null;
  try {
    membership = await currentMembership(user.client, user.userId, orgId);
  } catch (e) {
    return failed(e);
  }
  if (!membership) return refuse(403, "User has no organization membership");
  if (ROLE_RANK[membership.role] < ROLE_RANK[minimum]) return refuse(403, membership.role === "viewer" ? "viewer_read_only" : `${minimum} role required`);
  return { ...user, membership };
}

/** Worker and cron routes: the shared secret in `x-worker-secret`, compared in constant time. Null means authorized. */
export function workerAuthGuard(request: Request): Response | null {
  const expected = process.env.WORKER_SECRET;
  if (!expected) {
    log.error("[worker-auth] WORKER_SECRET is not set; refusing all worker requests (fail-closed).");
    return refuse(500, "Server misconfigured: WORKER_SECRET is not set.");
  }
  const presented = Buffer.from(request.headers.get("x-worker-secret") ?? "", "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return presented.length === wanted.length && timingSafeEqual(presented, wanted) ? null : refuse(401, "Unauthorized");
}
