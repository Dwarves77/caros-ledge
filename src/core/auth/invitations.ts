// Ported from old_repo/src/app/api/orgs/[org_id]/invitations/route.ts (lines 14-154)
// Ported from old_repo/src/app/api/orgs/[org_id]/invitations/[id]/route.ts (lines 11-61)
// Ported from old_repo/src/app/api/invitations/[token]/route.ts (lines 11-50)
// Ported from old_repo/src/app/api/invitations/mine/route.ts (lines 7-63)
// Ported from old_repo/src/app/api/invitations/[token]/accept/route.ts (lines 24-39)
import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { Db } from "@/core/db/clients";
import { dbError, HttpError } from "@/core/http/errors";
import { email as emailSchema } from "@/core/http/parse";
import { sendInvitationEmail, type EmailResult } from "@/core/shared/email";

export const inviteToken = z.string().regex(/^[0-9a-f]{64}$/i, "token must be 64 hex characters");
export const inviteRole = z.enum(["admin", "member", "viewer"]);
export const inviteBody = z.object({ email: emailSchema, role: inviteRole.default("member") });

const FIELDS = "id, invited_email, proposed_role, status, created_at, expires_at, accepted_at, declined_at, revoked_at, invited_by_user_id, token_last4";

/**
 * Issue an invitation as the caller (RLS enforces who may). The token is generated here and exists only in this request: it is inserted as
 * token_input, which the database hashes and clears (migration 0018), so the stored row holds sha256(token) and the last four characters
 * and nothing else. The raw token is returned once, inside invite_url, and is never logged. The email result is honest: not configured is
 * `configured: false`, and the caller shows the copy-link flow.
 */
export async function createInvitation(client: Db, input: { orgId: string; userId: string; email: string; role: string; baseUrl: string }): Promise<{ invitation: Record<string, unknown>; emailDelivery: EmailResult }> {
  const token = randomBytes(32).toString("hex");
  const { data, error } = await client.from("org_invitations").insert({ org_id: input.orgId, invited_email: input.email, invited_by_user_id: input.userId, proposed_role: input.role, token_input: token }).select("id, token_last4, invited_email, proposed_role, expires_at, status, created_at").maybeSingle();
  if (error?.code === "23505") throw new HttpError(409, "A pending invitation already exists for this email + org");
  if (error) throw dbError(error, { forbidden: "Only org admins can invite members" });
  if (!data) throw new HttpError(403, "Insert returned no row (RLS may have rejected the write)");
  const inviteUrl = `${input.baseUrl}/invitations/${token}`;
  const emailDelivery = await sendInvitationEmail({ to: input.email, inviteUrl, proposedRole: input.role });
  return { invitation: { ...data, invite_url: inviteUrl }, emailDelivery };
}

/** An org's invitations, newest first (bounded at 200); a pending one past its expiry reads as expired. */
export async function listInvitations(client: Db, orgId: string, now = Date.now()): Promise<Record<string, unknown>[]> {
  const { data, error } = await client.from("org_invitations").select(FIELDS).eq("org_id", orgId).order("created_at", { ascending: false }).limit(200);
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).map((inv) => ({ ...inv, status: inv.status === "pending" && new Date(inv.expires_at).getTime() <= now ? "expired" : inv.status }));
}

/** INV-155: revoke is scoped to the URL's org BEFORE the write; an invitation of another org is a 404 and the rpc never runs. */
export async function revokeInvitation(client: Db, orgId: string, invitationId: string): Promise<void> {
  const { data, error } = await client.from("org_invitations").select("id, org_id, status").eq("id", invitationId).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data || data.org_id !== orgId) throw new HttpError(404, "Invitation not found");
  const { error: rpcError } = await client.rpc("revoke_invitation", { p_invitation_id: invitationId });
  if (rpcError) throw dbError(rpcError, { forbidden: "Only org admins can revoke invitations", notFound: "Invitation not found" });
}

export async function lookupInvitation(client: Db, token: string): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc("lookup_invitation", { p_token: token });
  if (error) throw new HttpError(500, error.message);
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
  if (userError) throw new HttpError(500, userError.message);
  const address = found.user?.email?.toLowerCase();
  if (!address) return [];
  const { data, error } = await service.from("org_invitations").select("id, org_id, invited_email, proposed_role, status, created_at, expires_at, organizations(name, slug), token_last4").eq("invited_email", address).eq("status", "pending").order("created_at", { ascending: false }).limit(50);
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).filter((inv) => new Date(inv.expires_at).getTime() > now).map((inv) => {
    const org = inv.organizations as { name?: string; slug?: string } | null;
    return { id: inv.id, org_id: inv.org_id, org_name: org?.name ?? null, org_slug: org?.slug ?? null, proposed_role: inv.proposed_role, status: inv.status, created_at: inv.created_at, expires_at: inv.expires_at, token_last4: inv.token_last4 };
  });
}
