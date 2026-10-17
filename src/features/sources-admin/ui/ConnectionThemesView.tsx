"use client";

// Ported from old_repo/src/components/sources/ThemesView.tsx (lines 16-296)
import Link from "next/link";
import { useState } from "react";

import { formatNumber, formatLocaleDateTime } from "@/core/shared";
import { EmptyState, StatBlock } from "@/ui";
import { Button } from "@/ui";
import { Load, useAdminFetch } from "@/features/admin/ui/panel-kit";
import styles from "@/features/admin/ui/admin.module.css";

interface Theme {
  id: string;
  member_ids: string[];
  surfaces: string[] | null;
  convergence: number | null;
  band: "high" | "medium" | "low";
  density: number | null;
  dominant_signals: { signal: string; weight: number }[] | null;
  brief: { title: string; brief_md: string; generated_at: string; stale: boolean } | null;
}
interface Payload {
  themes: Theme[];
  stats: { total: number; avg_convergence: number; cross_surface_count: number; single_surface_count: number };
  last_run: { started_at: string; finished_at: string | null; status: string; themes_written: number | null; gaps_flagged: number | null } | null;
}

function ThemeCard({ theme }: { theme: Theme }) {
  const [open, setOpen] = useState(false);
  const band = theme.band;
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <span className={styles.actions}><span className={band === "high" ? styles.pillOn : styles.pill}>{band} convergence</span><span className={styles.muted}>{theme.member_ids.length} items · {(theme.surfaces ?? []).join(", ") || "no surface"}{theme.convergence !== null ? ` · ${theme.convergence.toFixed(2)}` : ""}</span></span>
        <span className={styles.chips}>{(theme.dominant_signals ?? []).map((s) => <span key={s.signal} className={styles.pill}>{s.signal.replace(/_/g, " ")}</span>)}</span>
        <span className={styles.chips}>{theme.member_ids.slice(0, 6).map((id) => <Link key={id} href={`/regulations/${encodeURIComponent(id)}`} className={styles.link}>{id.slice(0, 8)}</Link>)}</span>
        {theme.brief ? (
          <>
            <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>{theme.brief.title}{theme.brief.stale ? " (out of date)" : ""}</Button>
            {open ? <pre className={`${styles.note} ${styles.wrap}`}>{theme.brief.brief_md}</pre> : null}
          </>
        ) : <span className={styles.muted}>No brief has been written for this theme.</span>}
      </div>
    </div>
  );
}

/** The connection themes the flywheel clustered, strongest first: size, surfaces, convergence band, signals and members, with the brief when one exists (marked out of date when the membership moved). */
export function ConnectionThemesView() {
  const q = useAdminFetch<Payload>("/api/admin/themes?limit=50");
  return (
    <div className={styles.stack}>
      <Load q={q} what="Connection themes">
        {(d) => (
          <>
            <div className={styles.grid3}>
              <StatBlock label="Themes" value={formatNumber(d.stats.total)} />
              <StatBlock label="Cross-surface" value={formatNumber(d.stats.cross_surface_count)} />
              <StatBlock label="Average convergence" value={d.stats.avg_convergence.toFixed(2)} />
            </div>
            {d.last_run ? <p className={styles.muted}>Last run {formatLocaleDateTime(new Date(d.last_run.started_at))}: {d.last_run.status}, {d.last_run.themes_written ?? 0} themes written, {d.last_run.gaps_flagged ?? 0} gaps flagged.</p> : null}
            {d.themes.length === 0 ? <EmptyState>No themes have been computed yet.</EmptyState> : d.themes.map((t) => <ThemeCard key={t.id} theme={t} />)}
          </>
        )}
      </Load>
    </div>
  );
}
