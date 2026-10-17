// Ported from old_repo/src/components/detail/ThemeBriefCard.tsx (lines 1-35)
// The "Cluster synthesis" rail card: the title of the brief that explains the cluster this finding belongs to, the member count, and the staleness said in words when the cluster's membership has changed since the
// brief was written. It draws only what the theme view holds; no density figure (a pre-contract statistic a customer does not read).
import type { ThemeAnalysisView } from "@/core/themes";
import { SectionCard } from "@/ui";

import styles from "./research.module.css";

export function ThemeBriefCard({ brief }: { brief: Pick<ThemeAnalysisView, "title" | "memberCount" | "stale"> | null | undefined }) {
  if (!brief || !brief.title) return null;
  return (
    <SectionCard padding="12px 16px 14px">
      <p className={styles.eyebrow}>Cluster synthesis</p>
      <p className={styles.themeBrief}>{brief.title}</p>
      <p className={styles.fine}>
        {brief.memberCount} item{brief.memberCount === 1 ? "" : "s"}
        {brief.stale ? " · stale: membership changed" : ""}
      </p>
    </SectionCard>
  );
}
