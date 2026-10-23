"use client";

// Ported from old_repo/src/app/auth/reset-password/page.tsx (lines 16-112)
import { useState, type FormEvent } from "react";

import { browserClient } from "@/core/db/browser";
import { log } from "@/core/shared/log";

import styles from "./auth.module.css";
import { AuthErrorBanner, AuthField } from "./AuthPanel";
import { AuthFrame, AuthMasthead } from "./AuthFrame";
import { authSentence } from "./auth-sentences";

export default function ResetPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    const { error: failure } = await browserClient().auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/auth/update-password")}` });
    setLoading(false);
    if (failure) {
      log.warn("[auth] password reset failed:", failure.message);
      return setError(authSentence(failure));
    }
    setSent(true);
  };

  return (
    <AuthFrame>
      <div className={styles.column}>
        <AuthMasthead title="Reset your password" dek="We'll email you a link to set a new password." />
        {sent ? (
          <div className={styles.note}>
            If an account exists for <strong>{email}</strong>, a reset link is on its way. <a href="/login">Back to sign in</a>
          </div>
        ) : (
          <>
            {error && <AuthErrorBanner message={error} />}
            <form onSubmit={handleSubmit} className={styles.form}>
              <AuthField label="Work email">
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" className={styles.input} placeholder="name@company.com" />
              </AuthField>
              <button type="submit" disabled={loading} className={styles.primary}>
                {loading ? "Sending…" : "Send reset link"}
              </button>
            </form>
            <a href="/login" className={styles.back}>
              ← Back to sign in
            </a>
          </>
        )}
      </div>
    </AuthFrame>
  );
}
