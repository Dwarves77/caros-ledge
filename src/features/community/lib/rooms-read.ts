// Ported from old_repo/src/app/community/page.tsx (lines 134-451)
// The rooms home's reader, on the caller's own client: it reads the seven room groups, the member's memberships, the vertical groups, the rooms' latest threads with their sign-off requests and authors, the same-organisation
// roster, and the verified ledger through the SHARED list read (the machine-written half of Community: the items the intake and mint stages wrote). Tables: community_groups, community_group_members,
// community_posts, community_post_signoff_requests, community_group_invitations, profiles (my_profile and the same-organisation rows), intelligence_items (through the listing rpc and a uuid lookup), and the identity rpc.
// A read that fails is a stated failure of its own block (the others still draw), never an empty list and never a zero (INV-263).
import { LookupError } from "@/core/http/errors";
import type { Db } from "@/core/db/clients";
import { log } from "@/core/shared/log";
import type { Resource } from "@/core/types";
import { ALL_SECTORS } from "@/core/workspace/vocabulary";
import { readRemainder } from "@/features/lists";

import { loadIdentities, type IdentityRow } from "./identity";
import { POST_COLUMNS, shapePosts, type PostRow } from "./post-shape";
import { buildRooms, type RoomVM } from "./rooms-view";
import { CANONICAL_ROOM_SLUGS } from "./rooms";
import { loadInvitations, loadMe, loadMemberships, type Me } from "./shell-context";
import type { Membership, PendingInvitation, SignoffStatus } from "./types";

export interface VerticalGroupVM {
  id: string;
  slug: string;
  name: string;
  vertical: string;
  verticalLabel: string;
  description: string | null;
  memberCount: number;
  youOwn: boolean;
}
export interface RoomsHome {
  me: Me;
  rooms: RoomVM[];
  seeded: boolean;
  /** null: the vertical groups could not be read. */
  verticalGroups: VerticalGroupVM[] | null;
  memberships: Membership[];
  invitations: PendingInvitation[];
  /** One sentence per block that failed to read; the page says each with Retry. */
  failures: string[];
}

const THREAD_LIMIT = 60;
const ROSTER_LIMIT = 200;
const SECTOR_LABEL = new Map(ALL_SECTORS.map((s) => [s.id, s.label]));
const attempt = async <T>(what: string, run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    log.warn(`[community] ${what} could not be read:`, e instanceof Error ? e.message : String(e));
    return { ok: false };
  }
};

export async function readRoomsHome(db: Db, session: { userId: string; email: string; orgId: string | null }): Promise<RoomsHome> {
  const fallbackName = session.email.split("@")[0] ?? "";
  // The reads the page cannot be drawn without: a failure here throws (a stated page failure).
  const [me, memberships, invitations] = await Promise.all([loadMe(db, fallbackName), loadMemberships(db, session.userId), loadInvitations(db, session.userId)]);
  const failures: string[] = [];
  const rpc = session.orgId ? "get_workspace_intelligence_listings" : "get_workspace_intelligence_listings_public";
  const [groupsRes, verticalRes, ledgerRes, rosterRes] = await Promise.all([
    attempt("the room groups", async () => {
      const { data, error } = await db.from("community_groups").select("id, name, slug, member_count").in("slug", CANONICAL_ROOM_SLUGS);
      if (error) throw new LookupError("room groups", error);
      return (data ?? []) as Array<{ id: string; name: string; slug: string; member_count: number | null }>;
    }),
    attempt("the vertical groups", async () => {
      const { data, error } = await db.from("community_groups").select("id, name, slug, vertical, description, member_count, owner_user_id").not("vertical", "is", null).order("last_active_at", { ascending: false }).order("id", { ascending: true }).limit(60);
      if (error) throw new LookupError("vertical groups", error);
      return (data ?? []) as Array<{ id: string; name: string; slug: string; vertical: string | null; description: string | null; member_count: number | null; owner_user_id: string | null }>;
    }),
    attempt("the ledger", async () => {
      const r = await readRemainder(db, { orgId: session.orgId, rpc, firstPageSize: 0, pageSize: 500 });
      if (r.failed) throw new LookupError("ledger listing", "the listing failed");
      return r.rows;
    }),
    attempt("the roster", async () => {
      if (!me.orgId) return [] as Array<{ id: string; full_name: string | null; display_name: string | null; jurisdiction_overrides: string[] | null; workspace_role: string | null }>;
      const { data, error } = await db.from("profiles").select("id, full_name, display_name, jurisdiction_overrides, workspace_role").eq("org_id", me.orgId).order("id", { ascending: true }).limit(ROSTER_LIMIT);
      if (error) throw new LookupError("roster", error);
      return (data ?? []) as Array<{ id: string; full_name: string | null; display_name: string | null; jurisdiction_overrides: string[] | null; workspace_role: string | null }>;
    }),
  ]);
  const groups = groupsRes.ok ? groupsRes.value : [];
  if (!groupsRes.ok) failures.push("The regional rooms could not be loaded.");
  if (!verticalRes.ok) failures.push("The vertical groups could not be loaded.");
  if (!ledgerRes.ok) failures.push("The ledger counts could not be loaded.");
  if (!rosterRes.ok) failures.push("Who is in each room could not be loaded.");

  // The threads of the rooms and their sign-off requests; authors and requesters through the identity rpc.
  const roomIds = groups.map((g) => g.id);
  let posts: Array<PostRow & { referenced_intelligence_item_ids: string[] | null }> = [];
  let signoffs: Array<{ id: string; post_id: string; requested_by: string; status: SignoffStatus; created_at: string; primary_doc_url: string | null }> = [];
  let threadsFailed = false;
  let identities: Map<string, IdentityRow> = new Map();
  let shaped: Awaited<ReturnType<typeof shapePosts>> = { posts: [], identityFailed: false };
  if (groupsRes.ok && roomIds.length > 0) {
    const threads = await attempt("the room threads", async () => {
      const { data, error } = await db.from("community_posts").select(`${POST_COLUMNS}, referenced_intelligence_item_ids`).in("group_id", roomIds).is("parent_post_id", null).order("last_reply_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(THREAD_LIMIT);
      if (error) throw new LookupError("room threads", error);
      const rows = (data ?? []) as Array<PostRow & { referenced_intelligence_item_ids: string[] | null }>;
      const ids = rows.map((r) => r.id);
      const reqs = ids.length ? await db.from("community_post_signoff_requests").select("id, post_id, requested_by, status, created_at, primary_doc_url").in("post_id", ids) : { data: [], error: null };
      if (reqs.error) throw new LookupError("sign-off requests", reqs.error);
      return { rows, reqs: (reqs.data ?? []) as typeof signoffs };
    });
    if (threads.ok) {
      posts = threads.value.rows;
      signoffs = threads.value.reqs;
      const shapedRes = await attempt("the thread authors", () => shapePosts(db, session.userId, posts));
      if (shapedRes.ok) shaped = shapedRes.value;
      else threadsFailed = true;
      const requesters = await loadIdentities(db, signoffs.map((s) => s.requested_by));
      identities = requesters.byId;
      if (shaped.identityFailed || requesters.error) failures.push("Author names could not be loaded, so authors show as anonymous.");
    } else threadsFailed = true;
    if (threadsFailed) failures.push("The latest discussions could not be loaded.");
  }

  const resources: Resource[] = ledgerRes.ok ? ledgerRes.value : [];
  const names = new Map(signoffs.map((s) => [s.requested_by, requesterName(s.requested_by, session.userId, me.name, identities.get(s.requested_by))] as const));
  const roster = rosterRes.ok ? rosterRes.value.map((p) => ({ id: p.id, name: p.id === session.userId ? me.name : p.full_name?.trim() || p.display_name?.trim() || "Member", homes: p.jurisdiction_overrides ?? [], isOwner: p.workspace_role === "owner" })) : [];
  if (rosterRes.ok && !roster.some((p) => p.id === session.userId)) roster.push({ id: session.userId, name: me.name, homes: me.homes, isOwner: me.workspaceRole === "owner" });
  const rooms = buildRooms({
    resources,
    resourcesFailed: !ledgerRes.ok,
    threadsFailed,
    groups: new Map(groups.map((g) => [g.slug, { id: g.id, name: g.name, member_count: g.member_count ?? 0 }])),
    joinedGroupIds: new Set(memberships.map((m) => m.group_id)),
    posts: posts.map((p, i) => ({ id: p.id, group_id: p.group_id, title: p.title, body: p.body, reply_count: p.reply_count, created_at: p.created_at, last_reply_at: p.last_reply_at, referenced_intelligence_item_ids: p.referenced_intelligence_item_ids, signed_off_at: p.signed_off_at, author: shaped.posts[i]?.author ?? null })),
    signoffs,
    requesterNames: names,
    me: { userId: session.userId, homes: me.homes },
    roster,
  });
  // Citing needs an item's uuid (a list row's id is its legacy id where it has one): the first two items of each room, in one bounded lookup.
  const legacy = rooms.flatMap((r) => r.liveItems.filter((l) => !l.uuid).map((l) => l.id));
  if (legacy.length) {
    const found = await attempt("the cited items' ids", async () => {
      const { data, error } = await db.from("intelligence_items").select("id, legacy_id").in("legacy_id", legacy);
      if (error) throw new LookupError("item ids", error);
      return new Map(((data ?? []) as Array<{ id: string; legacy_id: string }>).map((r) => [r.legacy_id, r.id] as const));
    });
    if (found.ok) for (const r of rooms) for (const l of r.liveItems) l.uuid ??= found.value.get(l.id) ?? null;
  }
  return {
    me,
    rooms,
    seeded: groups.length > 0,
    verticalGroups: verticalRes.ok ? verticalRes.value.map((g) => ({ id: g.id, slug: g.slug, name: g.name, vertical: g.vertical ?? "", verticalLabel: SECTOR_LABEL.get(g.vertical ?? "") ?? g.vertical ?? "", description: g.description, memberCount: g.member_count ?? 0, youOwn: g.owner_user_id === session.userId })) : null,
    memberships,
    invitations,
    failures,
  };
}

/** The name a sign-off requester is shown under: you, the identity's name, or "Anonymous member" when it is withheld or could not be read. */
function requesterName(id: string, me: string, myName: string, identity: IdentityRow | undefined): string {
  if (id === me) return myName;
  return identity && !identity.anonymous ? (identity.display_name ?? "A member") : "Anonymous member";
}
