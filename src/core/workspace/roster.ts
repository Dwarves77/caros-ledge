// Ported from old_repo/src/lib/workspace/item-collab-shared.mjs (lines 1-77)
// Ported from old_repo/src/lib/workspace/item-collab-route.ts (lines 1-93)
// Ported from old_repo/src/app/api/workspace/bootstrap/logic.ts (lines 72-114)
// Ported from old_repo/src/app/api/workspace/archive-impact/route.ts (lines 93-124)
// Ported from old_repo/src/app/api/workspace/overrides/route.ts (lines 195-211)
import { admitItems } from "@/core/derived/admissible";
import type { Db } from "@/core/db/clients";
import { fetchAllRows } from "@/core/db/query";
import { LookupError, refuse } from "@/core/http/errors";
import { isRefusal, requireOrgRole } from "@/core/http/guard";
import { isUuid } from "@/core/http/parse";
import { log } from "@/core/shared/log";
import type { OrgRole } from "@/core/types";

export const NOTE_MAX_LENGTH = 4000;
export const MAX_ASSIGNEES_PER_REQUEST = 25;
/** A roster past this is refused rather than cut off: a name picker that silently drops members is wrong. */
const ROSTER_CAP = 1000;

const WRITE_ROLES = new Set<string>(["owner", "admin", "member"]);
const ADMIN_ROLES = new Set<string>(["owner", "admin"]);

/** A viewer reads; owner, admin and member also write. */
export const canWrite = (role: string | null | undefined): boolean => WRITE_ROLES.has(role ?? "");
/** Owner or admin. */
export const isOrgAdmin = (role: string | null | undefined): boolean => ADMIN_ROLES.has(role ?? "");

interface NameFields {
  full_name?: string | null;
  display_name?: string | null;
  email?: string | null;
}

/** Full name, display name, email, else the truncated id: the one order every roster surface uses. */
export function displayNameOf(user: NameFields | null | undefined, userId: string): string {
  return user?.full_name ?? user?.display_name ?? user?.email ?? `${String(userId).slice(0, 8)}...`;
}

export interface RosterMember {
  user_id: string;
  role: OrgRole;
  display_name: string;
  avatar_url: string | null;
}

type RosterRow = { user_id: string; role: OrgRole; user: (NameFields & { avatar_url?: string | null }) | null };

/**
 * The org's roster in one read pass, ordered by (created_at, id) so paging cannot skip or repeat a member. A failed read throws
 * LookupError: callers say the load failed, they never render an empty roster. Past 1000 members the read throws too.
 */
export async function loadRoster(client: Db, orgId: string): Promise<RosterMember[]> {
  let rows: RosterRow[];
  try {
    rows = (await fetchAllRows(
      (from, to) =>
        client
          .from("org_memberships")
          .select("user_id, role, created_at, user:profiles!user_id(full_name, display_name, avatar_url)")
          .eq("org_id", orgId)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      { cap: ROSTER_CAP },
    )) as unknown as RosterRow[];
  } catch (e) {
    throw new LookupError("org roster", e);
  }
  return rows.map((r) => ({ user_id: r.user_id, role: r.role, display_name: displayNameOf(r.user, r.user_id), avatar_url: r.user?.avatar_url ?? null }));
}

/** Names for the response of a write that already succeeded: a roster failure leaves names empty and is logged, it never fails the write. */
export async function namesAfterWrite(client: Db, orgId: string): Promise<Map<string, string>> {
  try {
    return nameIndex(await loadRoster(client, orgId));
  } catch (e) {
    log.warn("[roster] unavailable after a successful write, names omitted:", e instanceof Error ? e.message : String(e));
    return new Map();
  }
}

/** user_id to display name over a roster; a user no longer in the org is absent (resolves to null at the call site). */
export function nameIndex(members: readonly RosterMember[]): Map<string, string> {
  return new Map(members.map((m) => [m.user_id, m.display_name]));
}

/**
 * The org's members who watch the item (by uuid or legacy id), and whether the item is on the TEAM watchlist: one rpc (org_watchers, migration
 * 0024) in place of a roster read and chunked watchlist reads. Scoped by MEMBERSHIP, not by user_watchlist.org_id (nullable, contextual): the item
 * corpus is global, so an item-only filter would reach other tenants' watchers. A failed read throws LookupError.
 */
export async function orgWatchersOf(client: Db, orgId: string, itemKeys: string[]): Promise<{ watcherIds: string[]; onTeamWatchlist: boolean }> {
  const keys = [...new Set(itemKeys.filter(Boolean))];
  if (keys.length === 0) return { watcherIds: [], onTeamWatchlist: false };
  const { data, error } = await client.rpc("org_watchers", { p_org_id: orgId, p_item_ids: keys });
  if (error) throw new LookupError("org_watchers", error);
  const row = (data as { watcher_ids: string[] | null; on_team_watchlist: boolean | null }[] | null)?.[0];
  if (!row) throw new LookupError("org_watchers", new Error("no row returned"));
  return { watcherIds: row.watcher_ids ?? [], onTeamWatchlist: row.on_team_watchlist === true };
}

const DETAIL_PATH_RE = /^\/(?:regulations|market|operations|research)\/([^/]+)\/?$/;

/** The item id a detail page addresses, read from its own pathname; null on any other path. */
export function itemIdFromDetailPath(pathname: unknown): string | null {
  if (typeof pathname !== "string") return null;
  const m = DETAIL_PATH_RE.exec(pathname);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]) || null;
  } catch {
    return null;
  }
}

export interface CollabItem {
  id: string;
  legacyId: string | null;
  title: string | null;
  type: string | null;
  domain: number | null;
}
export interface CollabCtx {
  userId: string;
  orgId: string;
  role: OrgRole;
  item: CollabItem;
}
export interface CollabResult {
  status: number;
  body: unknown;
}

export const collabOk = (status: number, body: unknown): CollabResult => ({ status, body });
export const collabFail = (status: number, error: string): CollabResult => ({ status, body: { error } });

/** The request's JSON object body, or null when it is missing, malformed or not an object. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The one preamble of the notes and assignments routes: the caller (401), their organisation and role (403 with none), THEN the
 * verified item by uuid or legacy id (404), then the handler on the caller's own client (RLS decides every row). The item is read after the org is resolved
 * (B-0084). A failed lookup is a 503 through the route wrapper, never "not found".
 */
export async function runCollab(request: Request, context: { params: Promise<{ id: string }> }, run: (client: Db, ctx: CollabCtx) => Promise<CollabResult>): Promise<Response> {
  const auth = await requireOrgRole(request, "viewer");
  if (isRefusal(auth)) return auth;
  let itemKey: string;
  try {
    itemKey = decodeURIComponent((await context.params).id);
  } catch {
    return refuse(400, "Invalid item id");
  }
  const client = auth.client;
  const { data: item, error } = await admitItems(client.from("intelligence_items").select("id, legacy_id, title, item_type, domain"))
    .eq(isUuid(itemKey) ? "id" : "legacy_id", itemKey)
    .maybeSingle();
  if (error) throw new LookupError("intelligence_items", error);
  if (!item) return refuse(404, "That item was not found.");
  const result = await run(client, {
    userId: auth.userId,
    orgId: auth.membership.orgId,
    role: auth.membership.role,
    item: { id: item.id as string, legacyId: (item.legacy_id as string | null) ?? null, title: (item.title as string | null) ?? null, type: (item.item_type as string | null) ?? null, domain: (item.domain as number | null) ?? null },
  });
  return Response.json(result.body, { status: result.status, headers: auth.headers });
}
