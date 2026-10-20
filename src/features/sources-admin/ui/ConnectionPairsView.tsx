"use client";

// Ported from old_repo/src/components/sources/IntersectionDetectionView.tsx (lines 15-317)
import Link from "next/link";
import { useState } from "react";

import { formatNumber } from "@/core/shared";
import { EmptyState, FilterChip, FilterChipGroup, StatBlock } from "@/ui";
import { Load, useAdminFetch } from "@/features/admin/ui/panel-kit";
import styles from "@/features/admin/ui/admin.module.css";

interface Pair {
  item_a_id: string;
  item_a_title: string | null;
  item_a_legacy_id: string | null;
  item_a_intersection_summary: string | null;
  item_b_id: string;
  item_b_title: string | null;
  item_b_legacy_id: string | null;
  item_b_intersection_summary: string | null;
  basis: { signal: string; detail?: string; weight?: number }[];
  explicitly_linked: boolean;
  score: number | null;
  band: "strong" | "medium" | "weak" | "explicit";
}
interface Payload {
  intersections: Pair[];
  stats: { total: number; explicit_count: number; by_band: Record<string, number> };
}
const SIGNAL_WORDS: Record<string, string> = { shared_source: "Shared source", shared_scenario: "Shared scenario", shared_compliance_object: "Shared compliance object", shared_jurisdiction_topic: "Shared jurisdiction and topic" };
const SCORE_FLOORS = [0.3, 0.5, 0.9] as const;

/** Pairs of items the flywheel connected: the score band, the basis (why), and a link to each item. A failed read is the failure with Retry, never an empty list. */
export function ConnectionPairsView() {
  const [min, setMin] = useState<number>(0.5);
  const q = useAdminFetch<Payload>(`/api/admin/intersections?minScore=${min}&limit=100`);
  return (
    <div className={styles.stack}>
      <FilterChipGroup label="Minimum score">{SCORE_FLOORS.map((f) => <FilterChip key={f} active={min === f} onClick={() => setMin(f)}>{f}</FilterChip>)}</FilterChipGroup>
      <Load q={q} what="Connection pairs">
        {(d) => (
          <>
            <div className={styles.grid3}>
              <StatBlock label="Total pairs" value={formatNumber(d.stats.total)} />
              <StatBlock label="Strong" value={formatNumber(d.stats.by_band.strong ?? 0)} />
              <StatBlock label="Explicitly linked" value={formatNumber(d.stats.explicit_count)} />
            </div>
            {d.intersections.length === 0 ? <EmptyState>No pair of items is connected at this score.</EmptyState> : null}
            {d.intersections.map((p) => (
              <div key={`${p.item_a_id}|${p.item_b_id}`} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.actions}><span className={styles.pill}>{p.band}</span>{p.score !== null ? <span className={styles.muted}>score {p.score.toFixed(2)}</span> : null}{p.explicitly_linked ? <span className={styles.pillOn}>explicit</span> : null}</span>
                  <Link href={`/regulations/${encodeURIComponent(p.item_a_legacy_id || p.item_a_id)}`} className={styles.link}>{p.item_a_title ?? "An item that could not be read"}</Link>
                  <Link href={`/regulations/${encodeURIComponent(p.item_b_legacy_id || p.item_b_id)}`} className={styles.link}>{p.item_b_title ?? "An item that could not be read"}</Link>
                  <span className={styles.chips}>{p.basis.map((b, i) => <span key={i} className={styles.pill} title={b.detail}>{SIGNAL_WORDS[b.signal] ?? b.signal.replace(/_/g, " ")}</span>)}</span>
                  {p.item_a_intersection_summary ? <span className={styles.note}>{p.item_a_intersection_summary}</span> : null}
                </div>
              </div>
            ))}
          </>
        )}
      </Load>
    </div>
  );
}
