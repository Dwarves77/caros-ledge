"use client";

// Ported from old_repo/src/components/settings/SupersessionHistory.tsx (lines 17-79)
import Link from "next/link";

import { formatDate } from "@/core/shared";
import { EmptyState } from "@/ui";

import type { Section, SupersessionRow } from "../server/settings-data";

import { FailedBlock } from "./FailedBlock";
import styles from "./settings.module.css";

const SEVERITY_CLASS: Record<string, string> = { major: styles.major ?? "", minor: styles.minor ?? "", replacement: styles.replacement ?? "" };

/** The supersessions, newest first, each with both sides linked to their item page. An unknown severity reads in the neutral colour; a failed read says so. */
export function SupersessionHistory({ section }: { section: Section<SupersessionRow> }) {
  const rows = section.rows;
  if (!rows) return <FailedBlock>Supersession history did not load: {section.error}</FailedBlock>;
  if (rows.length === 0) return <EmptyState>No supersessions recorded.</EmptyState>;
  return (
    <div className={styles.history}>
      <p className="cl-field-label">Supersession history ({rows.length}{section.truncated ? "+" : ""})</p>
      {section.truncated ? <p className="cl-field-hint">Showing the most recent {rows.length}.</p> : null}
      <ul className={styles.historyList}>
        {rows.map((s) => (
          <li key={s.key} className={styles.historyRow}>
            <p className={styles.historyHead}>
              <span className={`${styles.severity} ${SEVERITY_CLASS[s.severity] ?? ""}`}>{s.severity}</span>
              <span>{formatDate(s.date)}</span>
            </p>
            <p className={styles.historyLine}>
              <span>Old</span>
              <Link href={s.old.href} className={styles.historyLink}>
                {s.old.title}
              </Link>
            </p>
            <p className={styles.historyLine}>
              <span>New</span>
              <Link href={s.new.href} className={styles.historyLink}>
                {s.new.title}
              </Link>
            </p>
            {s.note ? <p className="cl-field-hint">{s.note}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
