// Ported from old_repo/src/components/community/types.ts (lines 1-96)
// Ported from old_repo/src/components/community/api-client.ts (lines 89-154)
// Ported from old_repo/src/components/community/PostComposer.tsx (lines 32-61)
import type { NotificationKind } from "@/core/notifications/dispatch";

// One type per concept: the group, membership, invitation, entity, author and post shapes every Community route returns and every Community part draws.
export type GroupRole = "admin" | "moderator" | "member";
export type Privacy = "public" | "private";

export interface GroupSummary {
  id: string;
  name: string;
  slug: string;
  region: string;
  privacy: Privacy;
  member_count: number;
  weekly_post_count: number;
  last_active_at: string;
  description?: string | null;
  vertical?: string | null;
}

export interface Membership {
  group_id: string;
  role: GroupRole;
  starred: boolean;
  muted: boolean;
  joined_at: string;
  group: GroupSummary;
}

export interface PendingInvitation {
  id: string;
  group_id: string;
  inviter_user_id: string | null;
  created_at: string;
  group: Pick<GroupSummary, "id" | "name" | "slug" | "region" | "privacy">;
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  headshotUrl: string | null;
  employer: string;
  isPlatformAdmin: boolean;
}

/** A spine entity a thread binds to. */
export interface EntityRef {
  entity_id: string;
  kind: string;
  canonical_name: string;
}

/**
 * The one author projection. Name, company and headshot are null when the post or the member is anonymous; the verified mark is never withheld. `userId` is the author's id for the author and a
 * platform admin only (DFIX-1): everyone else gets null for an anonymous author, and for an author whose identity could not be read.
 */
export interface AuthorBlock {
  userId: string | null;
  name: string | null;
  company: string | null;
  headshotUrl: string | null;
  orgType: string | null;
  role: string | null;
  sector: string | null;
  region: string | null;
  verified: boolean;
  anonymous: boolean;
}

export interface PostView {
  id: string;
  group_id: string;
  parent_post_id: string | null;
  title: string | null;
  body: string;
  created_at: string;
  last_reply_at: string | null;
  reply_count: number;
  signed_off_at: string | null;
  author: AuthorBlock | null;
}

export interface OwnProfile {
  orgType: string | null;
  role: string | null;
  sector: string | null;
  region: string | null;
  verified: boolean;
  verifiedAt: string | null;
  verificationMethod: string | null;
  defaultAnonymous: boolean;
}

export type SignoffStatus = "pending" | "signed_off" | "declined" | "withdrawn";
export interface SignoffRequest {
  id: string;
  post_id: string;
  requested_by: string;
  status: SignoffStatus;
  verifier_id: string | null;
  primary_doc_url: string | null;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
}

export type { NotificationKind };
export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  payload: { title?: string; body?: string; link?: string; group_id?: string } & Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface ModerationReportView {
  id: string;
  target_kind: string;
  target_id: string;
  /** The caller filed this report. */
  is_mine: boolean;
  /** The caller may act on it (a moderator or admin of its group, or a platform admin). */
  can_review: boolean;
  group_name: string | null;
  reason: string | null;
  body: string | null;
  action: string | null;
  notes: string | null;
  status: "open" | "resolved" | "dismissed";
  created_at: string;
  resolved_at: string | null;
  post: { id: string; group_id: string; title: string | null; excerpt: string; created_at: string } | null;
}
