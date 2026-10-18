// Ported from old_repo/src/lib/community/identity.mjs (lines 12-281)
// Ported from old_repo/src/lib/community/viewer.ts (lines 1-24)
// R8.7 identity (shown by default; withheld per post or per member; the verified mark kept) and the DFIX-1 id rule (an anonymous author's id reaches only the author and a platform admin), as the one author
// projection every read route and page uses. Another member is read only through the community_identity definer (SEC-5): never an email, never another organisation's profiles row.
import { readOwnPlatformAdmin } from "@/core/auth/platform-admin";
import type { Db } from "@/core/db/clients";
import { log } from "@/core/shared/log";

import { ORG_TYPES } from "./labels";
import type { AuthorBlock } from "./types";

/** One row of community_identity: the per-member half of R8.7 is applied in SQL (a default-anonymous member arrives with name, company and headshot null and anonymous true). */
export interface IdentityRow {
  user_id: string;
  display_name: string | null;
  company_name: string | null;
  job_title: string | null;
  region: string | null;
  avatar_url: string | null;
  verified: boolean;
  anonymous: boolean;
}
export interface MemberProfileRow {
  user_id: string;
  org_type: string | null;
  role: string | null;
  sector: string | null;
  region: string | null;
  verified: boolean | null;
}
export interface Viewer {
  userId: string;
  isAdmin: boolean;
}
type IdentityLike = { anonymous?: boolean | null } | null | undefined;

/** The rpc returns at most this many rows per call; larger sets go in chunks. */
export const IDENTITY_IDS_PER_CALL = 200;

/** Per-post OR per-member anonymity at read: either one withholds name, company and headshot. */
export const effectiveAnonymous = (a: { postAnonymous?: boolean | null | undefined; identity?: IdentityLike }): boolean => a.postAnonymous === true || a.identity?.anonymous === true;

/** Whether an author id is withheld from readers other than the author and an admin: anonymous by either flag, OR the identity could not be resolved (unknown is not public, so it fails closed). */
export const idWithheld = (a: { postAnonymous?: boolean | null | undefined; identity?: IdentityLike }): boolean => !a.identity || effectiveAnonymous(a);

/** The author id one row shows a viewer: public for a named author; for a withheld one only the author themself and a platform admin (a real `true`) get it. */
export function authorIdForRow(a: { authorUserId: string | null; postAnonymous?: boolean | null | undefined; identity?: IdentityLike; viewer?: { userId: string; isAdmin?: boolean } | null }): string | null {
  if (!a.authorUserId) return null;
  if (!idWithheld(a)) return a.authorUserId;
  if (a.viewer?.userId && a.viewer.userId === a.authorUserId) return a.authorUserId;
  return a.viewer?.isAdmin === true ? a.authorUserId : null;
}

/**
 * Cross-organisation identities through community_identity, by ids (chunked) and/or a name query. Never throws: an rpc error returns an empty map and its message, so a feed degrades to "no author" (every
 * author anonymous, no id) and says so, never to a name it could not check.
 */
export async function loadIdentities(db: Pick<Db, "rpc">, ids: ReadonlyArray<string | null | undefined> | null, query: string | null = null): Promise<{ byId: Map<string, IdentityRow>; rows: IdentityRow[]; error: string | null }> {
  const byId = new Map<string, IdentityRow>();
  const rows: IdentityRow[] = [];
  const wanted = ids ? [...new Set(ids.filter((x): x is string => !!x))] : null;
  const text = query && query.trim() ? query.trim() : null;
  if ((!wanted || wanted.length === 0) && !text) return { byId, rows, error: null };
  const chunks: Array<string[] | null> = [];
  if (wanted && wanted.length > 0) for (let i = 0; i < wanted.length; i += IDENTITY_IDS_PER_CALL) chunks.push(wanted.slice(i, i + IDENTITY_IDS_PER_CALL));
  else chunks.push(null);
  for (const chunk of chunks) {
    const { data, error } = await db.rpc("community_identity", { p_ids: chunk, p_query: text });
    if (error) return { byId: new Map(), rows: [], error: error.message };
    for (const r of (Array.isArray(data) ? data : []) as IdentityRow[]) {
      rows.push(r);
      byId.set(r.user_id, r);
    }
  }
  return { byId, rows, error: null };
}

/** The org type, role, sector, region and verified of a bounded set of authors. A failed read throws (a feed is not drawn half-labelled). */
export async function loadMemberProfiles(db: Db, ids: string[]): Promise<Map<string, MemberProfileRow>> {
  const out = new Map<string, MemberProfileRow>();
  if (ids.length === 0) return out;
  const { data, error } = await db.from("community_member_profiles").select("user_id, org_type, role, sector, region, verified").in("user_id", ids);
  if (error) throw new Error(`member profile read failed: ${error.message}`);
  for (const p of (data ?? []) as MemberProfileRow[]) out.set(p.user_id, p);
  return out;
}

/** The viewer, with the platform-admin bit asked at most once and only when it can change an answer. A failed admin read is "not an admin": it never widens what is shown. */
export async function communityViewer(db: Pick<Db, "rpc">, userId: string, rows: Array<{ author_user_id: string | null; anonymous?: boolean | null }>, identities: Map<string, IdentityRow>): Promise<Viewer> {
  const needed = rows.some((r) => r.author_user_id && r.author_user_id !== userId && idWithheld({ postAnonymous: r.anonymous, identity: identities.get(r.author_user_id) ?? null }));
  if (!needed) return { userId, isAdmin: false };
  try {
    return { userId, isAdmin: await readOwnPlatformAdmin(db) };
  } catch (e) {
    log.warn("[community] the admin read failed; treating the viewer as not an admin:", e instanceof Error ? e.message : String(e));
    return { userId, isAdmin: false };
  }
}

const clean = (v: string | null | undefined): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The one author block of a post or reply. Name, company and headshot only when not anonymous; the verified mark, org type, role, sector and region always. A null author (deleted account) is null, never a stand-in. */
export function authorOf(a: { authorUserId: string | null; postAnonymous: boolean | null | undefined; identity: IdentityRow | null; member: MemberProfileRow | null; viewer: Viewer }): AuthorBlock | null {
  if (!a.authorUserId) return null;
  const anonymous = effectiveAnonymous({ postAnonymous: a.postAnonymous, identity: a.identity }) || !a.identity;
  const orgType = a.member?.org_type && ORG_TYPES.includes(a.member.org_type) ? a.member.org_type : null;
  return {
    userId: authorIdForRow({ authorUserId: a.authorUserId, postAnonymous: a.postAnonymous, identity: a.identity, viewer: a.viewer }),
    name: anonymous ? null : clean(a.identity?.display_name),
    company: anonymous ? null : clean(a.identity?.company_name),
    headshotUrl: anonymous ? null : clean(a.identity?.avatar_url),
    orgType,
    role: clean(a.member?.role) ?? clean(a.identity?.job_title),
    sector: clean(a.member?.sector),
    region: clean(a.member?.region) ?? clean(a.identity?.region),
    verified: a.member?.verified ?? a.identity?.verified ?? false,
    anonymous,
  };
}
