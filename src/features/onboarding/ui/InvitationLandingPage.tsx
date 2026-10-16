"use client";

// Ported from old_repo/src/components/onboarding/InvitationLandingPage.tsx (lines 30-238)
import { useEffect, useState } from "react";

import { requestJson } from "@/core/http/request-json";
import { formatLocaleDateTime } from "@/core/shared";
import { Button, InlineErrorBanner, StateNote } from "@/ui";

import styles from "./onboarding.module.css";

interface Invitation {
  org_name: string;
  invited_email: string;
  proposed_role: string;
  status: string;
  created_at: string;
  expires_at: string;
  is_expired: boolean;
}
type Phase = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "ready"; invitation: Invitation } | { kind: "done"; outcome: "accepted" | "declined" };

const STATUS: Record<string, string> = { pending: "Waiting for your answer", accepted: "Accepted", declined: "Declined", expired: "Expired", revoked: "Withdrawn by the sender" };

/**
 * The per-token invitation page (the emailed or copied link): who invited you, the role, the dates, a warning when the signed-in account is not the
 * invited address, then Accept (to the dashboard) or Decline. Every request is made in a try with a pending state, so a network failure ends the wait with
 * a message and the buttons come back (B-0163). The status reads as words, never the raw stored value.
 */
export function InvitationLandingPage({ token, userEmail }: { token: string; userEmail: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [acting, setActing] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void requestJson<{ invitation: Invitation }>(`/api/invitations/${token}`).then((r) => {
      if (!cancelled) setPhase(r.ok && r.data ? { kind: "ready", invitation: r.data.invitation } : { kind: "failed", message: r.error ?? "Could not load the invitation." });
    });
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  async function act(action: "accept" | "decline") {
    setError(null);
    setActing(action);
    const r = await requestJson(`/api/invitations/${token}/${action}`, { method: "POST" });
    setActing(null);
    if (!r.ok) return setError(r.error);
    setPhase({ kind: "done", outcome: action === "accept" ? "accepted" : "declined" });
    if (action === "accept") window.setTimeout(() => window.location.assign("/"), 800);
  }

  return (
    <div className={styles.landing}>
      <div className={styles.card}>
        <p className={styles.eyebrow}>Workspace invitation</p>
        {phase.kind === "loading" ? <p className="cl-field-hint">Loading invitation...</p> : null}
        {phase.kind === "failed" ? (
          <StateNote tone="error" action={{ label: "Retry", onClick: () => (setPhase({ kind: "loading" }), setAttempt((n) => n + 1)) }}>
            {phase.message}
          </StateNote>
        ) : null}
        {phase.kind === "ready" ? (
          <>
            <h1 className={styles.panelTitle}>Join {phase.invitation.org_name}</h1>
            <p className={styles.lead}>
              You&apos;ve been invited to join <b>{phase.invitation.org_name}</b> as <b>{phase.invitation.proposed_role}</b>.
            </p>
            <dl className={styles.facts}>
              <dt>Invited email</dt>
              <dd>{phase.invitation.invited_email}</dd>
              <dt>Signed in as</dt>
              <dd>{userEmail}</dd>
              <dt>Sent</dt>
              <dd>{formatLocaleDateTime(new Date(phase.invitation.created_at), { timeZone: "UTC" })} UTC</dd>
              <dt>Expires</dt>
              <dd>{formatLocaleDateTime(new Date(phase.invitation.expires_at), { timeZone: "UTC" })} UTC</dd>
              <dt>Status</dt>
              <dd>{STATUS[phase.invitation.is_expired ? "expired" : phase.invitation.status] ?? "Unavailable"}</dd>
            </dl>
            {phase.invitation.invited_email.toLowerCase() !== userEmail.toLowerCase() ? <p className={styles.warn}>This invitation was sent to a different email address. Sign in with the matching account to accept.</p> : null}
            {error ? <InlineErrorBanner message={error} /> : null}
            {phase.invitation.status === "pending" && !phase.invitation.is_expired ? (
              <div className={styles.navRight}>
                <Button variant="primary" disabled={acting !== null || phase.invitation.invited_email.toLowerCase() !== userEmail.toLowerCase()} onClick={() => void act("accept")}>
                  {acting === "accept" ? "Accepting..." : "Accept"}
                </Button>
                <Button variant="secondary" disabled={acting !== null} onClick={() => void act("decline")}>
                  {acting === "decline" ? "Declining..." : "Decline"}
                </Button>
              </div>
            ) : (
              <p className="cl-field-hint">This invitation can no longer be answered.</p>
            )}
          </>
        ) : null}
        {phase.kind === "done" ? (
          <div className={styles.done}>
            <h1 className={styles.panelTitle}>{phase.outcome === "accepted" ? "You're in" : "Invitation declined"}</h1>
            <p className={styles.lead}>{phase.outcome === "accepted" ? "Taking you to your dashboard..." : "You can close this page."}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
