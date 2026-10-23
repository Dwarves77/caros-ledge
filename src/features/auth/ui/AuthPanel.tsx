"use client";

// Ported from old_repo/src/components/auth/AuthPanel.tsx (lines 11-184)
import type { ReactNode } from "react";

import styles from "./auth.module.css";

export function AuthField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
    </div>
  );
}

const suffixFor = (redirect?: string | null) => (redirect ? `?redirect=${encodeURIComponent(redirect)}` : "");

export function AuthTabs({ active, redirect }: { active: "signin" | "signup"; redirect?: string | null }) {
  const suffix = suffixFor(redirect);
  return (
    <div className={styles.tabs}>
      <a href={`/login${suffix}`} className={active === "signin" ? styles.tabActive : styles.tab}>
        Sign in
      </a>
      <a href={`/signup${suffix}`} className={active === "signup" ? styles.tabActive : styles.tab}>
        Create account
      </a>
    </div>
  );
}

export function AuthErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" className={styles.banner}>
      {message}
    </div>
  );
}

export function AuthDivider() {
  return (
    <div className={styles.divider}>
      <span />
      or
      <span />
    </div>
  );
}

export function CheckEmailPanel({ email, note }: { email: string; note: string }) {
  return (
    <div className={styles.checkEmail}>
      <div className={styles.checkIcon}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
          <path d="m16 19 2 2 4-4" />
        </svg>
      </div>
      <h2 className={styles.checkTitle}>Check your email</h2>
      <p className={styles.checkText}>
        {note} <strong>{email}</strong>.
      </p>
    </div>
  );
}
