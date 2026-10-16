"use client";

// Ported from old_repo/src/components/profile/UserProfilePage.tsx (lines 664-719)
import { useState } from "react";

import { Button, FormCard, InlineErrorBanner } from "@/ui";

import type { ProfileRow } from "../lib/use-account";

import styles from "./account.module.css";

const HEADLINE = { active: "Verified contributor", pending: "Application under review", revoked: "Previous verification revoked", none: "Not a verifier" } as const;
const STATUS_LINE = { active: "This account holds a verifier badge.", pending: "This account's application is with the editorial team.", revoked: "This account holds no verifier badge.", none: "This account holds no verifier badge." } as const;

/** The verifier badge: the status, and a request for sign-off that names its failure. */
export function VerifierTab({ status, onApply }: { status: ProfileRow["verifier_status"]; onApply: () => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function apply() {
    setBusy(true);
    setError(null);
    setError(await onApply());
    setBusy(false);
  }
  return (
    <FormCard title="Verifier badge">
      <p className={styles.headline}>{HEADLINE[status]}</p>
      <p className={styles.note}>Verifier credentials mark community members whose claims are checked against primary documents before they carry weight in threads. {STATUS_LINE[status]}</p>
      {error ? <InlineErrorBanner message={`The request was not sent: ${error}`} /> : null}
      {status === "none" || status === "revoked" ? (
        <div className={styles.actions}>
          <Button variant="secondary" onClick={() => void apply()} disabled={busy}>
            {busy ? "Submitting..." : "Request verifier sign-off"}
          </Button>
        </div>
      ) : null}
    </FormCard>
  );
}
