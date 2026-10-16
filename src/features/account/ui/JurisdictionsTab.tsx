"use client";

// Ported from old_repo/src/components/profile/UserProfilePage.tsx (lines 608-662)
import Link from "next/link";

import { FormCard } from "@/ui";

import { jurisdictionLabels } from "../lib/labels";

import styles from "./account.module.css";

/** The reader's home jurisdictions (saved on the profile), read-only. */
export function JurisdictionsTab({ jurisdictionIds }: { jurisdictionIds: string[] }) {
  const labels = jurisdictionLabels(jurisdictionIds);
  const shown = labels.slice(0, 3);
  return (
    <FormCard title="Home jurisdictions" aside={`${labels.length} followed`}>
      {labels.length > 0 ? (
        <div className={styles.chips}>
          {shown.map((l) => (
            <span key={l} className={styles.chip}>
              {l}
            </span>
          ))}
          {labels.length > shown.length ? <span className={styles.chipMore}>+ {labels.length - shown.length} more</span> : null}
        </div>
      ) : (
        <p className={styles.muted}>No home jurisdictions set.</p>
      )}
      <p className={styles.note}>
        Jurisdiction weighting for the briefing lives in{" "}
        <Link href="/settings#general" className={styles.link}>
          Settings, Briefing schedule
        </Link>
        .
      </p>
    </FormCard>
  );
}
