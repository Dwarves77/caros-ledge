"use client";

// Ported from old_repo/src/app/auth/update-password/page.tsx (lines 10-122)
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { browserClient } from "@/core/db/browser";
import { Button, Input } from "@/ui";

import styles from "./auth.module.css";
import { AuthErrorBanner, AuthField } from "./AuthPanel";
import { AuthFrame, AuthMasthead } from "./AuthFrame";

export default function UpdatePasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirmPassword) return setError("Passwords do not match.");
    setLoading(true);
    const { error: failure } = await browserClient().auth.updateUser({ password });
    setLoading(false);
    if (failure) return setError(failure.message);
    setDone(true);
  };

  return (
    <AuthFrame>
      <div className={styles.column}>
        <AuthMasthead title="Set a new password" />
        {done ? (
          <div className={styles.note}>
            Password updated.{" "}
            <Button type="button" variant="primary" className={styles.full} onClick={() => router.push("/")}>
              Continue
            </Button>
          </div>
        ) : (
          <>
            {error && <AuthErrorBanner message={error} />}
            <form onSubmit={handleSubmit} className={styles.form}>
              <AuthField label="New password">
                <Input bare type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" minLength={8} className={styles.input} placeholder="At least 8 characters" />
              </AuthField>
              <AuthField label="Confirm new password">
                <Input bare type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required autoComplete="new-password" minLength={8} className={styles.input} placeholder="Re-enter password" />
              </AuthField>
              <Button type="submit" variant="primary" loading={loading} className={styles.full}>
                {loading ? "Saving…" : "Update password"}
              </Button>
            </form>
          </>
        )}
      </div>
    </AuthFrame>
  );
}
