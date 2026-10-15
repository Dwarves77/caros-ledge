"use client";

// Ported from old_repo/src/app/signup/page.tsx (lines 19-210)
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { sanitizeReturnPath } from "@/core/auth/route-policy";
import { browserClient } from "@/core/db/browser";

import styles from "./auth.module.css";
import { AuthAlreadyRegisteredNotice, AuthErrorBanner, AuthField, AuthTabs, CheckEmailPanel } from "./AuthPanel";
import { AuthFrame, AuthMasthead } from "./AuthFrame";
import { classifySignUpResult } from "./signup-result";

export default function SignupPage() {
  const router = useRouter();
  const safe = sanitizeReturnPath(useSearchParams().get("redirect"));
  const redirect = safe === "/" ? null : safe;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  // A signed-in visitor has no use for this form: straight home, one hop (the old page went via /login, which then bounced home).
  useEffect(() => {
    let cancelled = false;
    browserClient()
      .auth.getClaims()
      .then(({ data }) => {
        if (cancelled) return;
        if (data?.claims) router.replace("/");
        else setCheckingSession(false);
      })
      .catch(() => !cancelled && setCheckingSession(false));
    return () => {
      cancelled = true;
    };
  }, [router]);

  const handleSignup = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setAlreadyRegistered(false);
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirmPassword) return setError("Passwords do not match.");
    setLoading(true);
    const result = await browserClient().auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirect ?? "/onboarding")}` } });
    const outcome = classifySignUpResult(result);
    if (outcome === "error") setError(result.error?.message ?? "Sign up failed.");
    else if (outcome === "already_registered") setAlreadyRegistered(true);
    else setSubmitted(true);
    setLoading(false);
  };

  if (checkingSession) {
    return (
      <AuthFrame>
        <p className={styles.loading}>Loading…</p>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <div className={styles.column}>
        <AuthMasthead title="Create account" />
        <AuthTabs active="signup" redirect={redirect} />
        {submitted ? (
          <CheckEmailPanel email={email} note="We sent a confirmation link to" />
        ) : (
          <>
            {error && <AuthErrorBanner message={error} />}
            {alreadyRegistered && <AuthAlreadyRegisteredNotice redirect={redirect} />}
            <form onSubmit={handleSignup} className={styles.form}>
              <AuthField label="Work email">
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" className={styles.input} placeholder="name@company.com" />
              </AuthField>
              <AuthField label="Password">
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" minLength={8} className={styles.input} placeholder="At least 8 characters" />
              </AuthField>
              <AuthField label="Confirm password">
                <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required autoComplete="new-password" minLength={8} className={styles.input} placeholder="Re-enter password" />
              </AuthField>
              <button type="submit" disabled={loading} className={styles.primary}>
                {loading ? "Creating account…" : "Create account"}
              </button>
            </form>
            <p className={styles.help}>Invited to a workspace? Open the invitation link in your email, it signs you in and joins the workspace in one step.</p>
          </>
        )}
      </div>
    </AuthFrame>
  );
}
