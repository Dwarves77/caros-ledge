// Ported from old_repo/src/lib/email/send-invitation-email.ts (lines 1-31)

export interface InvitationEmail {
  to: string;
  inviteUrl: string;
  orgName?: string;
  /** The inviter's display name; an invitation that names neither who invited you nor to what cannot be acted on safely. */
  invitedBy?: string;
  proposedRole: string;
}
export interface EmailResult {
  delivered: boolean;
  /** False when no provider is configured: the honest result, never a silent success. */
  configured: boolean;
  reason?: string;
}
export interface EmailDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

const NOT_CONFIGURED: EmailResult = { delivered: false, configured: false, reason: "No email provider is configured on this deployment." };
const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The invitation e-mail through Resend (IMP-014, the free tier), a plain HTTPS call with no client library. Configured only when RESEND_API_KEY and INVITATION_FROM_EMAIL (an address on the domain verified in Resend) are both set;
 * otherwise the answer is the honest `configured: false` and the caller shows the copy-link flow. A provider refusal or a network failure is `delivered: false` with the reason, never a silent success and never a throw.
 */
export async function sendInvitationEmail(params: InvitationEmail, deps: EmailDeps = {}): Promise<EmailResult> {
  const env = deps.env ?? process.env;
  const key = env.RESEND_API_KEY?.trim();
  const from = env.INVITATION_FROM_EMAIL?.trim();
  if (!key || !from) return NOT_CONFIGURED;
  const where = params.orgName ? `the ${params.orgName} workspace` : "a workspace";
  const who = params.invitedBy ? `${params.invitedBy} has invited you` : "You have been invited";
  const text = `${who} to join ${where} on Caro's Ledge as ${params.proposedRole}.\n\nAccept the invitation: ${params.inviteUrl}\n`;
  const html = `<p>${escapeHtml(who)} to join ${escapeHtml(where)} on Caro's Ledge as ${escapeHtml(params.proposedRole)}.</p><p><a href="${escapeHtml(params.inviteUrl)}">Accept the invitation</a></p>`;
  try {
    const res = await (deps.fetchImpl ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [params.to], subject: `You are invited to Caro's Ledge`, text, html }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? { delivered: true, configured: true } : { delivered: false, configured: true, reason: `The e-mail provider answered HTTP ${res.status}.` };
  } catch (e) {
    return { delivered: false, configured: true, reason: `The e-mail provider could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
}
