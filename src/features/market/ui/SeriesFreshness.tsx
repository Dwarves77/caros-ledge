// Ported from old_repo/src/components/market/SeriesFreshness.tsx (lines 1-130)
// Freshness (spec 02 row 11): derived, never asserted. The badge is one series' state against its producer's cadence; the panel is the worst state on the board. Tones come from the tokens.
import { FRESHNESS } from "@/core/contracts/vocabularies";

import type { BoardFreshnessSummary, FreshnessCode, SeriesFreshness } from "../lib/freshness";

import styles from "./market.module.css";

const TONE: Record<FreshnessCode, string> = { current: "var(--awareness)", ageing: "var(--action)", stale: "var(--brand)", frozen: "var(--immediate)", unknown: "var(--ink-3)" };
const PANEL_COPY: Record<FreshnessCode, string> = {
  current: "Every populated series is within its registered cadence.",
  ageing: "At least one series is running late against its registered cadence.",
  stale: "At least one series is well past its registered cadence.",
  frozen: "At least one series has gone quiet: its source has stopped publishing, not merely slipped.",
  unknown: "No populated series carries a decided cadence, so degradation cannot be judged.",
};
const label = (code: FreshnessCode): string => (FRESHNESS[code] as { label?: string } | undefined)?.label ?? code;

/** One series' freshness: a dot in the state's tone, the state, and (unless the caller prints the date beside it) the as-of date. */
export function FreshnessBadge({ freshness, showAsOf = true }: { freshness: SeriesFreshness; showAsOf?: boolean }) {
  return (
    <p data-audit="series-freshness-badge" data-freshness={freshness.code} className={styles.freshBadge}>
      <span aria-hidden="true" className={styles.freshDot} style={{ background: TONE[freshness.code] }} />
      <b style={{ color: TONE[freshness.code] }}>{freshness.label}</b>
      {showAsOf && <span className={styles.muted}>{freshness.asOfDate ? `· as of ${freshness.asOfDate}` : "· no as-of date on record"}</span>}
    </p>
  );
}

/** The panel summary: the worst state governs the headline, the count strip breaks it down. Nothing populated, nothing to summarise. */
export function FreshnessPanel({ summary }: { summary: BoardFreshnessSummary }) {
  if (summary.total <= 0) return null;
  const counts = (["current", "ageing", "stale", "frozen"] as const).filter((k) => summary.counts[k] > 0).map((k) => `${summary.counts[k]} ${label(k).toLowerCase()}`);
  return (
    <div data-audit="series-freshness-panel" className={styles.freshPanel} style={{ borderColor: TONE[summary.worst] }}>
      <span className={styles.freshPanelHead} style={{ color: TONE[summary.worst] }}>
        Freshness · {label(summary.worst)}
      </span>
      <span className={styles.freshPanelCopy}>{PANEL_COPY[summary.worst]}</span>
      <span className={styles.muted}>{counts.join(" · ") || `${summary.counts.unknown} unknown`}</span>
    </div>
  );
}
