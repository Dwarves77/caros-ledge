"use client";

// Ported from old_repo/src/components/profile/UserProfilePage.tsx (lines 565-606)
import Link from "next/link";

import { FormCard, InlineErrorBanner } from "@/ui";

import { sectorLabels } from "../lib/labels";

import styles from "./account.module.css";

/** The workspace's sectors, read-only; they are chosen in Settings. */
export function SectorProfileTab({ sectorIds, failed }: { sectorIds: string[]; failed: string | undefined }) {
  const labels = sectorLabels(sectorIds);
  return (
    <FormCard title="Sector profile">
      {failed ? <InlineErrorBanner message={`The sectors did not load: ${failed}`} /> : null}
      {labels.length > 0 ? (
        <div className={styles.chips}>
          {labels.map((l) => (
            <span key={l} className={styles.chip}>
              {l}
            </span>
          ))}
        </div>
      ) : failed ? null : (
        <p className={styles.muted}>No sectors selected. The platform shows all freight sectors by default.</p>
      )}
      <p className={styles.note}>
        {labels.length > 0 ? "These sectors filter your default view, briefings and relevance. Edit the full list in " : "Sectors filter your default view, briefings and relevance. Choose yours in "}
        <Link href="/settings#general" className={styles.link}>
          Settings, Freight sectors
        </Link>
        .
      </p>
    </FormCard>
  );
}
