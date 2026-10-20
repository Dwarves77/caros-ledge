"use client";

// Ported from old_repo/src/components/sources/SourceHealthDashboard.tsx (lines 40-254)
import { formatLocaleDate, formatNumber } from "@/core/shared";
import { DOMAIN_LABELS } from "@/core/shared/domains";
import { customerTierOf } from "@/core/sources/tier-contract";
import type { AdminSource } from "@/features/admin/read/sources";
import { Absence, SectionCard, StatBlock, TierChip } from "@/ui";
import styles from "@/features/admin/ui/admin.module.css";

import { SourceRowActions } from "./SourceRowActions";
import { TierOverrideControl } from "./TierOverrideControl";

const pct = (v: number | null): string | null => (v === null ? null : `${Math.round(v * 100)}%`);

/** A figure, or the absence with its reason: a metric the database holds nothing for is never drawn as 0 or 50%. Pure. */
function metricOrAbsence(v: string | number | null) {
  return v === null ? <Absence reason="connect data" variant="dash" /> : v;
}

/** One registry row: the tier a customer sees, the name, the trust score (or its absence), the domains; opening it (a button, keyboard operable) shows the description, the trust metrics, the monitoring facts, and the per-source controls in one pane. */
export function SourceRow({ source, expanded, onToggle, onChanged }: { source: AdminSource; expanded: boolean; onToggle: () => void; onChanged: (patch: Partial<AdminSource>) => void }) {
  const tier = customerTierOf({ base_tier: source.base_tier, effective_tier: source.effective_tier, tier_override: source.tier_override });
  const m = source.metrics;
  return (
    <SectionCard as="article" aria-label={source.name}>
      <button type="button" className={styles.rowBtn} aria-expanded={expanded} onClick={onToggle}>
        <span className={styles.actions}>
          {tier ? <TierChip tier={tier} /> : null}
          <b className={`${styles.strong} ${styles.truncate}`}>{source.name}</b>
        </span>
        <span className={styles.actions}>
          <span className={styles.muted}>{source.trust.overall === null ? <Absence reason="connect data" variant="dash" /> : Math.round(source.trust.overall)}</span>
          <span className={source.status === "active" ? styles.pillOk : source.status === "inaccessible" || source.status === "suspended" ? styles.pillBad : styles.pill}>{source.status}</span>
        </span>
      </button>
      {expanded ? (
        <div className={styles.body}>
          {source.description ? <p className={styles.note}>{source.description}</p> : null}
          <a href={source.url} target="_blank" rel="noopener noreferrer" className={`${styles.link} ${styles.wrap}`}>{source.url}</a>
          <div className={styles.chips}>{source.domains.map((d) => <span key={d} className={styles.pill}>{DOMAIN_LABELS[d as keyof typeof DOMAIN_LABELS] ?? `Domain ${d}`}</span>)}</div>
          <div className={styles.grid2}>
            <StatBlock label="Accuracy" value={metricOrAbsence(pct(m.accuracy_rate))} note={m.confirmation_count === null ? undefined : `${formatNumber(m.confirmation_count)} confirmed`} />
            <StatBlock label="Accessibility" value={metricOrAbsence(pct(m.accessibility_rate))} note={m.total_checks === null ? undefined : `${formatNumber(m.total_checks)} checks`} />
            <StatBlock label="Independent citers" value={metricOrAbsence(m.independent_citers === null ? null : formatNumber(m.independent_citers))} />
            <StatBlock label="Conflicts" value={metricOrAbsence(m.conflict_count === null ? null : formatNumber(m.conflict_count))} />
          </div>
          <p className={styles.muted}>
            Frequency: {source.update_frequency ?? "not recorded"} · Method: {source.access_method ?? "not recorded"} · Last checked: {source.last_checked ? formatLocaleDate(new Date(source.last_checked)) : "never"}
            {source.paywalled ? " · Paywalled" : ""}{source.processing_paused ? " · Paused (admin)" : ""}
          </p>
          <SourceRowActions sourceId={source.id} paused={source.processing_paused} adminOnly={source.admin_only} onChanged={(p) => onChanged(p)} />
          <TierOverrideControl sourceId={source.id} onChanged={(p) => onChanged({ tier_override: p.tier_override as AdminSource["tier_override"], override_reason: p.override_reason })} />
        </div>
      ) : null}
    </SectionCard>
  );
}
