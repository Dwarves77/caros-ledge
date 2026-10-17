// Ported from old_repo/src/components/market/TrajectoryBars.tsx (lines 1-75)
// The detail page's trajectory: up to the last twelve points as bars, the tail anchored to the right. The title says how many points are drawn, not a fixed "12 wk" (the cadence is the item's own). The colours come from the band tokens.
import { tint } from "@/ui";

import styles from "./market.module.css";

export interface TrajectoryPoints {
  points: Array<{ date: string; value: number }>;
  base_label: string;
}

export function TrajectoryBars({ trajectoryPoints }: { trajectoryPoints: TrajectoryPoints }) {
  const slice = trajectoryPoints.points.slice(-12);
  const max = slice.reduce((m, p) => Math.max(m, p.value), 0);
  return (
    <div className={styles.traj}>
      <p className={styles.trajTitle}>Trajectory · last {slice.length} {slice.length === 1 ? "point" : "points"}</p>
      <div className={styles.trajBars} role="img" aria-label={`Trajectory over ${slice.length} points. ${trajectoryPoints.base_label}`}>
        {slice.map((p, i) => {
          const pct = max > 0 ? Math.round((p.value / max) * 100) : 0;
          return <span key={`${p.date}-${i}`} aria-hidden="true" className={styles.trajBar} style={{ height: `${Math.max(pct, 4)}%`, background: pct >= 100 ? "var(--immediate)" : tint("var(--action)", 25 + Math.round(pct * 0.7)) }} />;
        })}
      </div>
      <p className={styles.muted}>{trajectoryPoints.base_label}</p>
    </div>
  );
}
