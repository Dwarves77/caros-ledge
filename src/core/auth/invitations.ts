// Ported from old_repo/src/app/api/orgs/[org_id]/invitations/route.ts (lines 14-154)
// Ported from old_repo/src/app/api/orgs/[org_id]/invitations/[id]/route.ts (lines 11-61)
// Ported from old_repo/src/app/api/invitations/[token]/route.ts (lines 11-50)
// Ported from old_repo/src/app/api/invitations/mine/route.ts (lines 7-63)
// Ported from old_repo/src/app/api/invitations/[token]/accept/route.ts (lines 24-39)
import { z } from "zod";

import type { Db } from "@/core/db/clients";
import { appBaseUrl } from "@/core/http/app-url";
import { dbError, HttpError, LookupError } from "@/core/http/errors";
import { DB_SENTENCES } from "@/core/http/failure";
import { email as emailSchema } from "@/core/http/parse";
import { sendInvitationEmail, type EmailResult } from "@/core/shared/email";

/** The origin an invitation link is built on, for a route: an unset or unusable NEXT_PUBLIC_APP_URL is the route's 500 sentence (the cause goes to the log), asked BEFORE anything is written. */
export function inviteBaseUrl(): string {
  try {
    return appBaseUrl();
  } catch (e) {
    throw new HttpError(500, e instanceof Error ? e.message : "app url", {}, DB_SENTENCES["500"] as string);
  }
}

export const inviteToken = z.string().regex(/^[0-9a-f]{64}$/i, "token must be 64 hex characters");
const inviteRole = z.enum(["admin", "member", "viewer"]);
export const inviteBody = z.object({ email: emailSchema, role: inviteRole.default("member") });

const FIELDS = "id, invited_email, proposed_role, status, created_at, expires_at, accepted_at, declined_at, revoked_at, invited_by_user_id, token_last4";

/**
 * Issue an invitation as the caller through invite_member (migrations 0101 and 0121): who may is org_can, the invitation and its admin_events row are one transaction, and the database never looks at accounts, so an e-mail
 * with an account and one without answer identically. The database generates the token (32 random bytes, 64 hex characters: the caller chooses nothing), hashes and clears it (migration 0018), so the stored row holds
 * sha256(token) and the last four characters, and returns it once; it lives in this request, goes into invite_url and the e-mail, and is never logged. The e-mail names the organisation and who invited you (read before
 * anything is written); its result is honest: not configured is `configured: false`, and the caller shows the copy-link flow.
 */
export async function createInvitation(client: Db, input: { orgId: string; userId: string; email: string; role: string; baseUrl: string }): Promise<{ invitation: Record<string, unknown>; emailDelivery: EmailResult }> {
  const [org, inviter] = await Promise.all([client.from("organizations").select("name").eq("id", input.orgId).maybeSingle(), client.from("profiles").select("full_name, display_name").eq("id", input.userId).maybeSingle()]);
  if (org.error) throw new LookupError("organizations", org.error);
  if (inviter.error) throw new LookupError("profiles", inviter.error);
  const { data, error } = await client.rpc("invite_member", { p_org_id: input.orgId, p_email: input.email, p_role: input.role });
  if (error?.code === "23505") throw new HttpError(409, "A pending invitation already exists for this email + org");
  if (error) throw dbError(error, { forbidden: "Only org admins can invite members" });
  const minted = inviteToken.safeParse(data);
  if (!minted.success) throw new LookupError("invite_member", "the function returned no token");
  const token = minted.data;
  const inviteUrl = `${input.baseUrl}/invitations/${token}`;
  const who = (inviter.data?.full_name || inviter.data?.display_name || "").trim();
  const emailDelivery = await sendInvitationEmail({ to: input.email, inviteUrl, proposedRole: input.role, ...(org.data?.name ? { orgName: org.data.name } : {}), ...(who ? { invitedBy: who } : {}) });
  return { invitation: { invited_email: input.email, proposed_role: input.role, invite_url: inviteUrl }, emailDelivery };
}

/** An org's invitations, newest first (bounded at 200); a pending one past its expiry reads as expired. */
export async function listInvitations(client: Db, orgId: string, now = Date.now()): Promise<Record<string, unknown>[]> {
  const { data, error } = await client.from("org_invitations").select(FIELDS).eq("org_id", orgId).order("created_at", { ascending: false }).limit(200);
  if (error) throw new LookupError("org_invitations", error);
  return (data ?? []).map((inv) => ({ ...inv, status: inv.status === "pending" && new Date(inv.expires_at).getTime() <= now ? "expired" : inv.status }));
}

/** INV-155: revoke is scoped to the URL's org BEFORE the write; an invitation of another org is a 404 and the rpc never runs. */
export async function revokeInvitation(client: Db, orgId: string, invitationId: string): Promise<void> {
  const { data, error } = await client.from("org_invitations").select("id, org_id, status").eq("id", invitationId).maybeSingle();
  if (error) throw new LookupError("org_invitations", error);
  if (!data || data.org_id !== orgId) throw new HttpError(404, "Invitation not found");
  const { error: rpcError } = await client.rpc("revoke_invitation", { p_invitation_id: invitationId });
  if (rpcError) throw dbError(rpcError, { forbidden: "Only org admins can revoke invitations", notFound: "Invitation not found" });
}

export async function lookupInvitation(client: Db, token: string): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc("lookup_invitation", { p_token: token });
  if (error) throw new LookupError("lookup_invitation", error);
  const row = (data as Record<string, unknown>[] | null)?.[0];
  if (!row) throw new HttpError(404, "Invitation not found");
  return row;
}

/** Accept returns the joined org id; the email match and the ban guard live in the rpc (migrations 156, 371). */
export async function acceptInvitation(client: Db, token: string): Promise<string> {
  const { data, error } = await client.rpc("accept_invitation", { p_token: token });
  if (error) throw dbError(error, { forbidden: "Not authorized to accept this invitation", notFound: "Invitation not found" });
  return data as string;
}

/** Accept by the row id (the in-app list carries no raw token, migration 0018). The same rules as the token path: migration 0028 is their one home. */
export async function acceptInvitationById(client: Db, invitationId: string): Promise<string> {
  const { data, error } = await client.rpc("accept_invitation_by_id", { p_invitation_id: invitationId });
  if (error) throw dbError(error, { forbidden: "Not authorized to accept this invitation", notFound: "Invitation not found" });
  return data as string;
}

export async function declineInvitationById(client: Db, invitationId: string): Promise<void> {
  const { error } = await client.rpc("decline_invitation_by_id", { p_invitation_id: invitationId });
  if (error) throw dbError(error, { forbidden: "Not authorized to decline this invitation", notFound: "Invitation not found" });
}

export async function declineInvitation(client: Db, token: string): Promise<void> {
  const { error } = await client.rpc("decline_invitation", { p_token: token });
  if (error) throw dbError(error, { forbidden: "Not authorized to decline this invitation", notFound: "Invitation not found" });
}

/** The caller's own pending, unexpired invitations by account email (service client: the invitee has no org yet). The raw token is not stored, so the list carries token_last4 only. A failed user lookup is an error, never an empty list. */
export async function pendingInvitationsFor(service: Db, userId: string, now = Date.now()): Promise<Record<string, unknown>[]> {
  const { data: found, error: userError } = await service.auth.admin.getUserById(userId);
  if (userError) throw new LookupError("auth user", userError);
  const address = found.user?.email?.toLowerCase();
  if (!address) return [];
  const { data, error } = await service.from("org_invitations").select("id, org_id, invited_email, proposed_role, status, created_at, expires_at, organizations(name, slug), token_last4").eq("invited_email", address).eq("status", "pending").order("created_at", { ascending: false }).limit(50);
  if (error) throw new LookupError("org_invitations", error);
  return (data ?? []).filter((inv) => new Date(inv.expires_at).getTime() > now).map((inv) => {
    const org = inv.organizations as { name?: string; slug?: string } | null;
    return { id: inv.id, org_id: inv.org_id, org_name: org?.name ?? null, org_slug: org?.slug ?? null, proposed_role: inv.proposed_role, status: inv.status, created_at: inv.created_at, expires_at: inv.expires_at, token_last4: inv.token_last4 };
  });
}
