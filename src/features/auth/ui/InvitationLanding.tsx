"use client";

// Ported from old_repo/src/components/onboarding/InvitationLandingPage.tsx (lines 13-238)
import { useEffect, useState } from "react";

import { formatLocaleDateTime } from "@/core/shared/dates";

import styles from "./auth.module.css";
import { AuthErrorBanner } from "./AuthPanel";

interface Invitation {
  org_name: string;
  invited_email: string;
  proposed_role: string;
  status: string;
  created_at: string;
  expires_at: string;
  is_expired: boolean;
}

export function InvitationLanding({ token, userEmail }: { token: string; userEmail: string }) {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<"accept" | "decline" | null>(null);
  const [done, setDone] = useState<"accepted" | "declined" | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/invitations/${token}`)
      .then(async (res) => ({ ok: res.ok, json: await res.json() }))
      .then(({ ok, json }) => !cancelled && (ok ? setInvitation(json.invitation) : setError(json.error || "Could not load invitation.")))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [token]);

  const act = async (action: "accept" | "decline") => {
    setError(null);
    setActing(action);
    const res = await fetch(`/api/invitations/${token}/${action}`, { method: "POST" });
    const json = await res.json().catch(() => ({}));
    setActing(null);
    if (!res.ok) return setError(json.error || `Could not ${action} invitation.`);
    setDone(action === "accept" ? "accepted" : "declined");
    if (action === "accept") setTimeout(() => (window.location.href = "/"), 800);
  };

  const mismatch = !!invitation && invitation.invited_email.toLowerCase() !== userEmail.toLowerCase();
  return (
    <div className={styles.landing}>
      <div className={styles.card}>
        <p className={styles.cardEyebrow}>Workspace invitation</p>
        {loading && <p className={styles.loading}>Loading invitation...</p>}
        {error && !loading && <AuthErrorBanner message={error} />}
        {invitation && !loading && !done && (
          <>
            <h1 className={styles.cardTitle}>Join {invitation.org_name}</h1>
            <p className={styles.cardText}>
              You&apos;ve been invited to join <b>{invitation.org_name}</b> as <b>{invitation.proposed_role}</b>.
            </p>
            <dl className={styles.facts}>
              <dt>Invited email:</dt>
              <dd>{invitation.invited_email}</dd>
              <dt>You&apos;re signed in as:</dt>
              <dd>{userEmail}</dd>
              <dt>Sent:</dt>
              <dd>{formatLocaleDateTime(new Date(invitation.created_at))}</dd>
              <dt>Expires:</dt>
              <dd>{formatLocaleDateTime(new Date(invitation.expires_at))}</dd>
              <dt>Status:</dt>
              <dd>{invitation.status}</dd>
            </dl>
            {mismatch && <div className={styles.warn}>This invitation was sent to a different email address. Sign in with the matching account to accept.</div>}
            {invitation.status === "pending" && !invitation.is_expired ? (
              <div className={styles.actions}>
                <button type="button" className={styles.primary} onClick={() => act("accept")} disabled={!!acting || mismatch}>
                  {acting === "accept" ? "Accepting..." : "Accept"}
                </button>
                <button type="button" className={styles.secondary} onClick={() => act("decline")} disabled={!!acting}>
                  {acting === "decline" ? "Declining..." : "Decline"}
                </button>
              </div>
            ) : (
              <p className={styles.loading}>This invitation is no longer actionable.</p>
            )}
          </>
        )}
        {done === "accepted" && (
          <div className={styles.done}>
            <h2 className={styles.cardTitle}>You&apos;re in</h2>
            <p className={styles.cardText}>Redirecting to your dashboard...</p>
          </div>
        )}
        {done === "declined" && (
          <div className={styles.done}>
            <h2 className={styles.cardTitle}>Invitation declined</h2>
            <p className={styles.cardText}>You can close this page.</p>
          </div>
        )}
      </div>
    </div>
  );
}
