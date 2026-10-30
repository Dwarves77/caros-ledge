"use client";

// Ported from old_repo/src/app/login/page.tsx (lines 20-180)
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { sanitizeReturnPath } from "@/core/auth/route-policy";
import { browserClient } from "@/core/db/browser";
import { log } from "@/core/shared/log";
import { Button, Input } from "@/ui";

import styles from "./auth.module.css";
import { AuthDivider, AuthErrorBanner, AuthField, AuthTabs, CheckEmailPanel } from "./AuthPanel";
import { AuthFrame, AuthMasthead } from "./AuthFrame";
import { authSentence } from "./auth-sentences";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [magicLoading, setMagicLoading] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const router = useRouter();
  const redirect = sanitizeReturnPath(useSearchParams().get("redirect"));

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    const { error: failure } = await browserClient().auth.signInWithPassword({ email, password });
    if (failure) {
      log.warn("[auth] sign-in failed:", failure.message);
      setError(authSentence(failure));
      setLoading(false);
      return;
    }
    router.push(redirect);
    router.refresh();
  };

  const handleMagicLink = async () => {
    if (!email.trim()) return setError("Enter your work email above first.");
    setError("");
    setMagicLoading(true);
    const { error: failure } = await browserClient().auth.signInWithOtp({ email, options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirect)}` } });
    setMagicLoading(false);
    if (failure) {
      log.warn("[auth] magic link failed:", failure.message);
      return setError(authSentence(failure));
    }
    setMagicSent(true);
  };

  return (
    <AuthFrame>
      <div className={styles.column}>
        <AuthMasthead title="Sign in" />
        <AuthTabs active="signin" redirect={redirect !== "/" ? redirect : null} />
        {magicSent ? (
          <CheckEmailPanel email={email} note="We sent a sign-in link to" />
        ) : (
          <>
            {error && <AuthErrorBanner message={error} />}
            <form onSubmit={handleLogin} className={styles.form}>
              <AuthField label="Work email">
                <Input bare type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" className={styles.input} placeholder="name@company.com" />
              </AuthField>
              <AuthField label="Password">
                <Input bare type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" className={styles.input} placeholder="••••••••" />
              </AuthField>
              <div className={styles.forgot}>
                <a href="/auth/reset-password">Forgot password?</a>
              </div>
              <Button type="submit" variant="primary" loading={loading} className={styles.full}>
                {loading ? "Signing in…" : "Sign in"}
              </Button>
            </form>
            <AuthDivider />
            <Button type="button" loading={magicLoading} onClick={handleMagicLink} className={styles.full}>
              {magicLoading ? "Sending link…" : "Continue with a magic link"}
            </Button>
            <p className={styles.help}>Invited to a workspace? Open the invitation link in your email, it signs you in and joins the workspace in one step.</p>
          </>
        )}
      </div>
    </AuthFrame>
  );
}
