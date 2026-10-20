// New in R2e (M5). The typed output schema of GET /api/account/export: the response IS this parse of export_own_account's answer (migration 0104), so a column the database function adds later reaches no member until it is
// named here. Every section is the member's own rows; rows that name other people are counted by the database, never listed.
import { z } from "zod";

const text = z.string().nullable();
const when = z.string().nullable();
const rows = <S extends z.ZodRawShape>(shape: S) => z.array(z.object(shape));

export const accountExport = z.object({
  profile: z.object({ id: z.string(), email: text, display_name: text, full_name: text, headline: text, bio: text, avatar_url: text, organization: text, job_title: text, linkedin_url: text, region: z.array(z.string()), topic_interests: z.array(z.string()).nullable(), timezone: z.string(), sector_overrides: z.array(z.string()), jurisdiction_overrides: z.array(z.string()), transport_mode_overrides: z.array(z.string()), notification_preferences: z.record(z.string(), z.unknown()).nullable(), settings: z.record(z.string(), z.unknown()), affiliation_type: text, verifier_status: z.string(), verifier_since: when, membership_tier: text, contribution_score: z.number().nullable(), is_platform_admin: z.boolean(), last_active_at: when, created_at: z.string(), updated_at: z.string() }).nullable(),
  memberships: rows({ org_id: z.string(), org_name: z.string(), role: z.string(), joined_at: z.string() }),
  consents: rows({ org_name: z.string(), role: z.string(), basis: z.string(), consented_at: z.string() }),
  invitations_received: rows({ org_name: z.string(), proposed_role: z.string(), status: z.string(), created_at: z.string() }),
  invitations_issued_count: z.number(),
  watchlist: rows({ org_id: z.string().nullable(), item_type: z.string(), item_id: z.string(), created_at: z.string() }),
  item_state: rows({ org_id: z.string().nullable(), item_id: z.string(), is_archived: z.boolean(), archive_note: text, archived_at: when }),
  saved_views: rows({ surface: z.string(), name: z.string(), query: z.string(), created_at: z.string() }),
  notifications: rows({ kind: z.string(), payload: z.record(z.string(), z.unknown()), read_at: when, created_at: z.string() }),
  notification_preferences: z.object({ enabled: z.boolean(), on_mention: z.boolean(), on_reply_in_my_threads: z.boolean(), on_new_post_in_joined_groups: z.boolean(), on_invite: z.boolean(), on_promote: z.boolean(), channels: z.array(z.string()), updated_at: z.string() }).nullable(),
  notes: rows({ org_id: z.string(), item_id: z.string(), body: z.string(), created_at: z.string(), edited_at: when }),
  assignments: rows({ org_id: z.string(), item_id: z.string(), due_on: when, state: z.string(), created_at: z.string(), assigned_to_me: z.boolean() }),
  tags_created: rows({ org_id: z.string(), name: z.string(), created_at: z.string() }),
  community: z.object({
    profile: z.object({ org_type: z.string(), role: text, sector: text, region: text, verified: z.boolean(), verified_at: when, verification_method: text, default_anonymous: z.boolean(), created_at: z.string() }).nullable(),
    groups: rows({ group_name: z.string(), role: z.string(), joined_at: z.string(), owner: z.boolean() }),
    posts: rows({ id: z.string(), group_id: z.string(), parent_post_id: z.string().nullable(), title: text, body: z.string(), anonymous: z.boolean().nullable(), created_at: z.string() }),
    signoff_requests: rows({ post_id: z.string(), status: z.string(), primary_doc_url: text, decision_note: text, created_at: z.string(), decided_at: when }),
    reports_filed: rows({ target_kind: z.string(), reason: z.string(), body: text, status: z.string(), created_at: z.string() }),
  }),
  acts_performed: rows({ created_at: z.string(), action: z.string(), target_kind: z.string(), reason: text }),
});
export type AccountExport = z.infer<typeof accountExport>;
