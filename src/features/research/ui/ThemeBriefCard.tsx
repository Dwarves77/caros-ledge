// Ported from old_repo/src/components/detail/ThemeBriefCard.tsx (lines 1-35)
// The "Cluster synthesis" rail card: the title of the brief that explains the cluster this finding belongs to, the member count, and, in words, that the brief was written for an earlier membership of the cluster. It draws only what the theme view holds; no density figure (a pre-contract statistic a customer does not read).
import type { ThemeAnalysisView } from "@/core/themes";
import { RailCard } from "@/ui";

import styles from "./research.module.css";

export function ThemeBriefCard({ brief }: { brief: Pick<ThemeAnalysisView, "title" | "memberCount" | "stale"> | null | undefined }) {
  if (!brief || !brief.title) return null;
  return (
    <RailCard title="Cluster synthesis">
      <p className={styles.themeBrief}>{brief.title}</p>
      <p className={styles.fine}>
        {brief.memberCount} item{brief.memberCount === 1 ? "" : "s"}
        {brief.stale ? " · written for an earlier membership" : ""}
      </p>
    </RailCard>
  );
}
