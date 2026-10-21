// Ported from old_repo/src/app/community/page.tsx (lines 44-120)
// Ported from old_repo/src/app/community/page.tsx (lines 246-451)
// The rooms home's view models, pure: which verified ledger items sit in which room (by jurisdiction, then ISO code), the room's three leading topic words and two citable items (no ledger count: Community is social only), its threads with their sign-off
// state and authors, and who is here. The old page built all of this inline in a 419-line component with its own surface-route and label maps; the surface route is the core one (detailHref).
import { canonicalSurface, detailHref } from "@/core/lists";
import { isUuid } from "@/core/http/parse";
import type { Resource } from "@/core/types";

import { homeJurisdictionsInRoom, ROOMS, roomForJurisdiction, type RoomKey } from "./rooms";
import type { AuthorBlock, SignoffStatus } from "./types";

export interface LiveItem {
  id: string;
  /** The item's uuid when the list row carries one; a citation needs it. */
  uuid: string | null;
  title: string;
  meta: string;
  href: string;
}
export interface ThreadSignoff {
  requestId: string;
  status: SignoffStatus;
  isMine: boolean;
  requesterName: string;
}
export interface ThreadVM {
  id: string;
  groupId: string;
  title: string;
  body: string;
  replyCount: number;
  createdAt: string;
  lastActivityAt: string;
  referencedItemIds: string[];
  author: AuthorBlock | null;
  isYou: boolean;
  signedOffAt: string | null;
  /** The primary document the sign-off was checked against; null when none was recorded (no badge). */
  signedOffDocUrl: string | null;
  signoff: ThreadSignoff | null;
}
export interface RosterMemberVM {
  name: string;
  isYou: boolean;
  isOwner: boolean;
}
export interface RoomVM {
  key: RoomKey;
  name: string;
  short: string;
  groupId: string | null;
  joined: boolean;
  /** A hint for the default room (a home jurisdiction falls here); never a membership claim. */
  youHere: boolean;
  themes: string[];
  liveItems: LiveItem[];
  threads: ThreadVM[];
  /** False when the threads could not be read: the tile then says so instead of "no discussions yet". */
  threadsKnown: boolean;
  roster: RosterMemberVM[];
}

export interface PostInput {
  id: string;
  group_id: string;
  title: string | null;
  body: string;
  reply_count: number | null;
  created_at: string;
  last_reply_at: string | null;
  referenced_intelligence_item_ids: string[] | null;
  signed_off_at: string | null;
  author: AuthorBlock | null;
}
export interface SignoffInput {
  id: string;
  post_id: string;
  requested_by: string;
  status: SignoffStatus;
  created_at: string;
  primary_doc_url?: string | null;
}
export interface RosterInput {
  id: string;
  name: string;
  homes: string[];
  isOwner: boolean;
}
export interface RoomsInput {
  resources: Resource[];
  threadsFailed: boolean;
  /** room slug -> its group. */
  groups: ReadonlyMap<string, { id: string; name: string; member_count: number }>;
  joinedGroupIds: ReadonlySet<string>;
  posts: PostInput[];
  signoffs: SignoffInput[];
  /** requester id -> the name to show for them (already anonymised where it must be). */
  requesterNames: ReadonlyMap<string, string>;
  me: { userId: string; homes: string[] };
  roster: RosterInput[];
}

const PRIO_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3 };
const SURFACE_LABEL = { regulations: "Regulation", market: "Market Intel", operations: "Operations", research: "Research" } as const;
const titleCase = (s: string): string => s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** The room a ledger item sits in: its jurisdiction, then its ISO codes in order; null when none matches. */
function roomForResource(r: Resource): RoomKey | null {
  const direct = roomForJurisdiction(r.jurisdiction);
  if (direct) return direct;
  for (const iso of r.jurisdictionIso ?? []) {
    const k = roomForJurisdiction(iso);
    if (k) return k;
  }
  return null;
}

/** Per post, the request that matters: an open one first, else the newest decided one. */
function chooseSignoffs(rows: SignoffInput[]): Map<string, SignoffInput> {
  const by = new Map<string, SignoffInput>();
  for (const s of rows) {
    const cur = by.get(s.post_id);
    const better = !cur || (s.status === "pending" && cur.status !== "pending") || ((s.status === "pending") === (cur.status === "pending") && s.created_at > cur.created_at);
    if (better) by.set(s.post_id, s);
  }
  return by;
}

export function buildRooms(i: RoomsInput): RoomVM[] {
  const signoffByPost = chooseSignoffs(i.signoffs);
  const threadsByGroup = new Map<string, ThreadVM[]>();
  for (const p of i.posts) {
    const req = signoffByPost.get(p.id);
    const list = threadsByGroup.get(p.group_id) ?? [];
    list.push({
      id: p.id,
      groupId: p.group_id,
      title: p.title ?? p.body.slice(0, 120),
      body: p.body,
      replyCount: p.reply_count ?? 0,
      createdAt: p.created_at,
      lastActivityAt: p.last_reply_at ?? p.created_at,
      referencedItemIds: p.referenced_intelligence_item_ids ?? [],
      author: p.author,
      isYou: !!p.author && p.author.userId === i.me.userId,
      signedOffAt: p.signed_off_at,
      signedOffDocUrl: p.signed_off_at && req?.status === "signed_off" ? (req.primary_doc_url ?? null) : null,
      signoff: req ? { requestId: req.id, status: req.status, isMine: req.requested_by === i.me.userId, requesterName: i.requesterNames.get(req.requested_by) ?? "A member" } : null,
    });
    threadsByGroup.set(p.group_id, list);
  }
  return ROOMS.map((def) => {
    const group = i.groups.get(def.slug);
    const inRoom = i.resources.filter((r) => roomForResource(r) === def.key).sort((a, b) => (PRIO_RANK[a.priority] ?? 3) - (PRIO_RANK[b.priority] ?? 3));
    const liveItems = inRoom.slice(0, 2).map((r) => ({
      id: r.id,
      uuid: isUuid(r.id) ? r.id : null,
      title: r.title,
      meta: `${SURFACE_LABEL[canonicalSurface(r)]} · ${r.jurisdiction ? titleCase(r.jurisdiction) : def.short}${r.severity || r.priority ? ` · ${(r.severity || r.priority).toString().toLowerCase()}` : ""}`,
      href: detailHref(r),
    }));
    const tally = new Map<string, number>();
    for (const r of inRoom) {
      const t = (r.topic || r.theme || "").toString().trim();
      if (t) tally.set(t, (tally.get(t) ?? 0) + 1);
    }
    const themes = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => titleCase(t));
    const me = i.me;
    return {
      key: def.key,
      name: def.name,
      short: def.short,
      groupId: group?.id ?? null,
      joined: group ? i.joinedGroupIds.has(group.id) : false,
      youHere: homeJurisdictionsInRoom(me.homes, def.key),
      themes,
      liveItems,
      threads: group ? (threadsByGroup.get(group.id) ?? []) : [],
      threadsKnown: !i.threadsFailed,
      roster: i.roster.filter((p) => homeJurisdictionsInRoom(p.homes, def.key)).map((p) => ({ name: p.name, isYou: p.id === me.userId, isOwner: p.isOwner })),
    };
  });
}
