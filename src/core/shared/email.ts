// Ported from old_repo/src/lib/email/send-invitation-email.ts (lines 1-31)

export interface InvitationEmail {
  to: string;
  inviteUrl: string;
  orgName?: string;
  proposedRole: string;
}
export interface EmailResult {
  delivered: boolean;
  /** False when no provider is configured: the honest result, never a silent success. */
  configured: boolean;
  reason?: string;
}

/** The invitation email seam. No provider is wired yet, so every call answers `configured: false` and the caller shows the copy-link flow. */
export async function sendInvitationEmail(params: InvitationEmail): Promise<EmailResult> {
  void params;
  return { delivered: false, configured: false, reason: "No email provider is configured on this deployment." };
}
