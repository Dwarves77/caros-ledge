// Ported from old_repo/src/components/community/api-client.ts (lines 1-235)
// Ported from old_repo/src/components/community/PostList.tsx (lines 88-113)
// Ported from old_repo/src/components/community/GroupHeader.tsx (lines 94-147)
// Ported from old_repo/src/components/community/ModerationActions.tsx (lines 46-130)
// The one typed client for the Community routes: 33 raw fetch sites and nine copies of a JSON-safe wrapper become one request() with one error shape ({ ok, status, data, error }). It never throws, a refusal carries the
// server's own sentence, and a network failure is a result the screen shows. Nothing under features/community/ui calls fetch.
import { requestJson, type JsonResult } from "@/core/http/request-json";

import type { AuthorBlock, EntityRef, ModerationReportView, NotificationRow, OwnProfile, PostView, SignoffRequest } from "./types";

export type Result<T> = JsonResult<T>;
const q = (params: Record<string, string | number | boolean | null | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const send = <T>(method: string, path: string, body?: unknown): Promise<Result<T>> => requestJson<T>(path, { method, ...(body === undefined ? {} : { body }) });
const base = "/api/community";

export interface MemberView {
  role: string;
  joined_at: string;
  muted_until: string | null;
  name: string | null;
  headshot_url: string | null;
  anonymous: boolean;
  is_self: boolean;
}
export interface SearchHits {
  posts: Array<{ id: string; title: string; body_excerpt: string; group_id: string; group_name: string | null; group_slug: string | null; created_at: string }>;
  groups: Array<{ id: string; name: string; slug: string; region: string; privacy: "public" | "private"; member_count: number }>;
  people: Array<{ name: string | null; headshot_url: string | null }>;
}
export interface EntityThread extends PostView {
  entity_id: string;
  entity_kind: string;
  group_name: string | null;
  group_slug: string | null;
}

export const communityApi = {
  createGroup: (input: { name: string; vertical: string; description?: string }) => send<{ group: { id: string; slug: string; name: string } }>("POST", `${base}/groups`, input),
  joinGroup: (id: string) => send<{ ok: true; state: "joined" | "already-member" }>("POST", `${base}/groups/${id}/join`),
  leaveGroup: (id: string) => send<{ ok: true }>("DELETE", `${base}/groups/${id}/members`),
  setStarred: (id: string, starred: boolean) => send<{ ok: true }>("PATCH", `${base}/groups/${id}/star`, { starred }),
  setMuted: (id: string, muted: boolean) => send<{ ok: true }>("PATCH", `${base}/groups/${id}/mute`, { muted }),
  saveSettings: (id: string, patch: { name?: string; description?: string | null; privacy?: "public" | "private"; privacy_reason?: string | null }) => send<{ ok: true; group: { name: string; description: string | null; privacy: "public" | "private" } }>("PATCH", `${base}/groups/${id}/settings`, patch),
  members: (id: string) => send<{ members: MemberView[]; truncated: boolean; identity_failed: boolean }>("GET", `${base}/groups/${id}/members`),
  invitations: (id: string) => send<{ invitations: Array<{ id: string; created_at: string; invitee_name: string | null; invitee_avatar: string | null; can_revoke: boolean }>; identity_failed: boolean }>("GET", `${base}/groups/${id}/invitations`),
  candidates: (id: string, query: string) => send<{ candidates: Array<{ user_id: string; name: string; headshot_url: string | null }> }>("GET", `${base}/groups/${id}/invite-candidates${q({ q: query })}`),
  invite: (id: string, inviteeUserId: string) => send<{ ok: true; invitation_id: string; notified: boolean }>("POST", `${base}/groups/${id}/invite`, { invitee_user_id: inviteeUserId }),
  acceptInvitation: (id: string) => send<{ ok: true; group_id: string }>("POST", `${base}/invitations/${id}/accept`),
  declineInvitation: (id: string) => send<{ ok: true }>("POST", `${base}/invitations/${id}/decline`),
  revokeInvitation: (id: string) => send<{ ok: true }>("POST", `${base}/invitations/${id}/revoke`),

  posts: (groupId: string, before?: string | null) => send<{ posts: PostView[]; next_cursor: string | null; identity_failed: boolean }>("GET", `${base}/posts${q({ group_id: groupId, before })}`),
  createPost: (input: { group_id: string; title: string; body: string; entity_ids: string[]; anonymous?: boolean }) => send<{ post: PostView & { entity_ids: string[] } }>("POST", `${base}/posts`, input),
  editPost: (id: string, patch: { title?: string; body?: string }) => send<{ post: PostView }>("PATCH", `${base}/posts/${id}`, patch),
  deletePost: (id: string) => send<{ ok: true }>("DELETE", `${base}/posts/${id}`),
  removePost: (id: string, note: string) => send<{ ok: true; removed: true; notified: boolean }>("POST", `${base}/posts/${id}/remove`, { note }),
  replies: (postId: string, after?: string | null) => send<{ replies: PostView[]; next_cursor: string | null; identity_failed: boolean }>("GET", `${base}/posts/${postId}/replies${q({ after })}`),
  reply: (postId: string, body: string) => send<{ reply: PostView; notified: boolean }>("POST", `${base}/posts/${postId}/replies`, { body }),
  cite: (postId: string, itemId: string) => send<{ ok: true; cited: string[] }>("POST", `${base}/posts/${postId}/cite`, { item_id: itemId }),
  entities: (query: string) => send<{ entities: EntityRef[] }>("GET", `${base}/entities${q({ q: query })}`),
  entityThreads: (entityId: string, before?: string | null) => send<{ entity_id: string; threads: EntityThread[]; next_cursor: string | null; identity_failed: boolean }>("GET", `${base}/entities/${encodeURIComponent(entityId)}/threads${q({ before })}`),

  requestSignoff: (postId: string) => send<{ request: SignoffRequest }>("POST", `${base}/posts/${postId}/signoff`),
  decideSignoff: (id: string, decision: "signed_off" | "declined", note?: string, primaryDocUrl?: string) => send<{ request: SignoffRequest }>("POST", `${base}/signoff/${id}/decide`, { decision, decision_note: note ?? null, primary_doc_url: primaryDocUrl ?? null }),
  withdrawSignoff: (id: string) => send<{ request: SignoffRequest }>("POST", `${base}/signoff/${id}/withdraw`),

  reports: (params: { status?: string; reason?: string; before?: string | null }) => send<{ reports: ModerationReportView[]; next_cursor: string | null }>("GET", `${base}/moderation/reports${q(params)}`),
  report: (input: { post_id: string; reason: string; body?: string }) => send<{ ok: true; report_id: string | null }>("POST", `${base}/moderation/reports`, input),
  act: (reportId: string, action: "dismiss" | "warn" | "remove" | "mute" | "ban", notes?: string, days?: 1 | 7 | 30) => send<{ ok: true; status: string; action: string; notified: boolean }>("POST", `${base}/moderation/reports/${reportId}`, { action, ...(notes ? { notes } : {}), ...(days ? { days } : {}) }),

  notifications: (params: { unread_only?: boolean; limit?: number; before?: string | null }) => send<{ notifications: NotificationRow[]; total_matching: number; unread_count: number; next_cursor: string | null }>("GET", `${base}/notifications${q(params)}`),
  markRead: (id: string) => send<{ ok: true }>("POST", `${base}/notifications/${id}`, { action: "mark_read" }),
  markAllRead: () => send<{ ok: true; updated: number }>("POST", `${base}/notifications`, { action: "mark_all_read" }),
  notificationCounts: () => send<{ groups: Array<{ group_id: string; unread_count: number }>; total_unread: number }>("GET", `${base}/notifications/counts`),

  profile: () => send<{ profile: OwnProfile }>("GET", `${base}/profile`),
  saveProfile: (input: { org_type: string; role?: string | null; sector?: string | null; region?: string | null; default_anonymous?: boolean }) => send<{ profile: OwnProfile }>("PUT", `${base}/profile`, input),
  verifyRecord: () => send<{ domain: string; host: string; value: string }>("GET", `${base}/profile/verify`),
  verify: () => send<{ profile: OwnProfile }>("POST", `${base}/profile/verify`),

  search: (query: string, scope: string) => send<SearchHits>("GET", `${base}/search${q({ q: query, scope })}`),
};

export type { AuthorBlock, EntityRef };
