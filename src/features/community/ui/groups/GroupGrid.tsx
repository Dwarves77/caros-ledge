"use client";

// Ported from old_repo/src/components/community/BrowseGroupsGrid.tsx (lines 35-113)
// The directory's grid of group tiles, wrapping to the width it has (the old grid's 300 px minimum could not fit beside the 280 px sidebar at 375 px), and the empty state that says which region is empty.
import { EmptyState } from "@/ui";

import type { GroupSummary } from "../../lib/types";
import styles from "../community.module.css";

import { GroupCard, type MembershipState } from "./GroupCard";

export interface BrowseRow {
  group: GroupSummary;
  state: MembershipState;
}

export function GroupGrid({ rows, emptyTitle, nowIso }: { rows: BrowseRow[]; emptyTitle: string; nowIso: string }) {
  if (rows.length === 0) return <EmptyState>{emptyTitle}. Try another region or check back as the directory grows.</EmptyState>;
  return (
    <div className={styles.groupGrid}>
      {rows.map((r) => (
        <GroupCard key={r.group.id} group={r.group} state={r.state} nowIso={nowIso} />
      ))}
    </div>
  );
}
