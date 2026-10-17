"use client";

// Ported from old_repo/src/components/admin/IssueFilterCaption.tsx (lines 11-68)
import { Button } from "@/ui";

import styles from "./admin.module.css";

const LABELS: Record<string, string> = { provisional: "Provisional sources", "materialization-failed": "Materialization failures", "attribution-mismatch": "Source attribution mismatches", "recently-approved": "Recently auto-approved (spot-check)" };
/** The words for a filter a queue tap-through asked for; a coverage filter names its jurisdiction. Pure. */
export const issueFilterLabel = (filter: string): string => LABELS[filter] ?? (filter.startsWith("coverage:") ? `Coverage gap: ${filter.slice(9)}` : filter);

/** The scope a tap-through asked for, with a 44 px Clear: the filter is said, never silently reset. */
export function IssueFilterCaption({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <div role="status" className={styles.actions}>
      <span className={styles.muted}>Filter:</span>
      <strong className={styles.strong}>{label}</strong>
      <Button variant="secondary" size="sm" onClick={onClear}>Clear</Button>
    </div>
  );
}
