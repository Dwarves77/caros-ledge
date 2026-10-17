// Ported from old_repo/src/app/api/notices/route.ts (lines 1-95)
// Ported from old_repo/src/app/api/notices/logic.ts (lines 1-34)
// Ported from old_repo/src/app/api/notices/resolve-watched-entities.ts (lines 1-84)
// GET /api/notices: the recalculation feed of the caller's ORGANISATION watchlist (a recalculation is a shared fact: "a figure your team tracks changed"). BUILD-PLAN ruling 3: signed-in callers only. Superseded derived values are not readable
// by a member (the raw table has no member policy), so the pairs are read through the service client AFTER the guard; a failed read is a 503 with Retry-After, never an empty 200 (an outage must not read as "nothing changed").
import { currentMembership } from "@/core/auth/membership";
import { fetchAllByIdChunks, serviceClient, type Db } from "@/core/db";
import { formatCorridorLabel, parseCorridorName } from "@/core/entities";
import { HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { fetchSupersededNotices, type SupersededNotice } from "@/core/propagation";

export const DEFAULT_WINDOW_DAYS = 30;
export const noticesClock = { now: (): Date => new Date() };

/** `?since=` as an ISO instant; absent or unparseable is the default window before `now` (a malformed value degrades, it does not 400). */
export function resolveSince(raw: string | null, now: Date): string {
  const parsed = raw ? new Date(raw) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000).toISOString();
}

export interface NoticeItem extends SupersededNotice {
  entityLabel: string | null;
}
/** A notice with its entity's label: the entity's display name, else the corridor label its name spells, else the name; never blank when the entity is known. */
export function attachEntityLabels(notices: readonly SupersededNotice[], entities: ReadonlyArray<{ entity_id: string; canonical_name: string; display_name: string | null }>): NoticeItem[] {
  const byId = new Map(entities.map((e) => [e.entity_id, e]));
  return notices.map((n) => {
    const e = n.entityId ? byId.get(n.entityId) : undefined;
    const corridor = parseCorridorName(e?.canonical_name);
    return { ...n, entityLabel: e ? (e.display_name || (corridor ? formatCorridorLabel(corridor) : e.canonical_name)) : null };
  });
}

const ITEM_TYPES = new Set(["reg", "signal", "research", "operations"]);
/** The entities the watched rows are about: an item's instrument entity and its entity refs, a source's organisation. A market series contributes none (it is not an entity's page). A failed read throws. */
export async function resolveWatchedEntityIds(db: Db, watched: ReadonlyArray<{ item_type: string; item_id: string }>): Promise<string[]> {
  const itemIds = [...new Set(watched.filter((w) => ITEM_TYPES.has(w.item_type)).map((w) => w.item_id))];
  const sourceIds = [...new Set(watched.filter((w) => w.item_type === "source").map((w) => w.item_id))];
  const read = async <T,>(label: string, ids: string[], q: (slice: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> =>
    fetchAllByIdChunks<T>(ids, async (slice) => {
      const { data, error } = await q(slice);
      if (error) throw new Error(`notices: ${label} read failed: ${error.message}`);
      return data ?? [];
    }, { manyPerId: true });
  const [items, refs, sources] = await Promise.all([
    read<{ instrument_entity_id: string | null }>("intelligence_items", itemIds, (s) => db.from("intelligence_items").select("id, instrument_entity_id").in("id", s)),
    read<{ entity_id: string }>("entity_refs", itemIds, (s) => db.from("entity_refs").select("entity_id").eq("ref_table", "intelligence_items").in("ref_id", s)),
    read<{ organisation_entity_id: string | null }>("sources", sourceIds, (s) => db.from("sources").select("id, organisation_entity_id").in("id", s)),
  ]);
  return [...new Set([...items.map((i) => i.instrument_entity_id), ...refs.map((r) => r.entity_id), ...sources.map((s) => s.organisation_entity_id)].filter((x): x is string => !!x))];
}

export const GET = route("/api/notices", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const since = resolveSince(new URL(request.url).searchParams.get("since"), noticesClock.now());
  const headers = { ...auth.headers, "Cache-Control": "private, no-store" };
  try {
    const membership = await currentMembership(auth.client, auth.userId);
    // No organisation means no team watchlist and nothing to notify on: the honest empty, not a failure.
    if (!membership) return ok(headers, { notices: [], since });
    const { data, error } = await auth.client.from("org_watchlist").select("item_type, item_id").eq("org_id", membership.orgId).limit(5000);
    if (error) throw new Error(`org_watchlist read failed: ${error.message}`);
    const entityIds = await resolveWatchedEntityIds(auth.client, (data ?? []) as Array<{ item_type: string; item_id: string }>);
    const svc = serviceClient();
    const notices = await fetchSupersededNotices(svc, entityIds, since);
    const labelled = await fetchAllByIdChunks<{ entity_id: string; canonical_name: string; display_name: string | null }>([...new Set(notices.map((n) => n.entityId).filter((x): x is string => !!x))], async (slice) => {
      const r = await svc.from("entities").select("entity_id, canonical_name, display_name").in("entity_id", slice);
      if (r.error) throw new Error(`entities read failed: ${r.error.message}`);
      return r.data ?? [];
    });
    return ok(headers, { notices: attachEntityLabels(notices, labelled), since });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new LookupError("recalculation notices", e);
  }
});
