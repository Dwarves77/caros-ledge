"use client";

// Ported from old_repo/src/components/admin/UpcomingObligationsPanel.tsx (lines 71-185)
// Ported from old_repo/src/components/admin/UpcomingObligationsPanel.tsx (lines 211-233)
// Ported from old_repo/src/lib/connections/forward-event-format.mjs (lines 12-28)
import { useState } from "react";

import { FilterChip, FilterChipGroup, EmptyState } from "@/ui";
import { EVENT_KINDS, KIND_LABELS, PRECISIONS, type EventKind } from "@/features/obligations/kinds";

import { Load, Panel, useAdminFetch } from "./panel-kit";
import styles from "./admin.module.css";

interface Payload {
  events: { id: string; event_date: string; date_precision: string; event_kind: string; obligation_text: string; source_kind: string; confidence: string; item: { title: string | null; jurisdiction_iso: string[] | null } }[];
  stats: { total: number; by_kind: Record<string, number>; by_precision: Record<string, number> };
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A date at the precision it has: a year-precision obligation shows its year and never a day it does not have; a malformed date is shown as given. Parsed from the parts, never through a viewer timezone. Pure. */
function eventDateLabel(date: string, precision: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  const month = MONTHS[Number(mo) - 1] ?? mo;
  return precision === "year" ? y : precision === "month" ? `${month} ${y}` : `${month} ${Number(d)}, ${y}`;
}

/** Dated, obligation-bound events extracted from already-grounded brief content, on verified live items. Filter by kind and precision. Read-only. */
export function UpcomingObligationsPanel() {
  const [kind, setKind] = useState<EventKind | null>(null);
  const [precision, setPrecision] = useState<string | null>(null);
  const q = useAdminFetch<Payload>(`/api/admin/forward-events?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(precision ? { precision } : {}) })}`);
  return (
    <Panel title="Upcoming obligations" aside={q.data ? `${q.data.stats.total} shown` : undefined} onRefresh={q.reload}>
      <p className={styles.note}>Dated events extracted from grounded brief content. A year-precision obligation shows only its year.</p>
      <FilterChipGroup label="Kind">
        {EVENT_KINDS.map((k) => <FilterChip key={k} active={kind === k} onClick={() => setKind(kind === k ? null : k)}>{KIND_LABELS[k]}{q.data && !kind ? ` · ${q.data.stats.by_kind[k] ?? 0}` : ""}</FilterChip>)}
      </FilterChipGroup>
      <FilterChipGroup label="Precision">
        {PRECISIONS.map((p) => <FilterChip key={p} active={precision === p} onClick={() => setPrecision(precision === p ? null : p)}>{p}</FilterChip>)}
      </FilterChipGroup>
      <Load q={q} what="Upcoming obligations">
        {(d) =>
          d.events.length === 0 ? (
            <EmptyState>No upcoming obligations match.</EmptyState>
          ) : (
            d.events.map((e) => (
              <div key={e.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.actions}><b className={styles.strong}>{eventDateLabel(e.event_date, e.date_precision)}</b><span className={styles.pill}>{KIND_LABELS[e.event_kind as EventKind] ?? e.event_kind}</span><span className={styles.pill}>{e.date_precision}</span></span>
                  <span className={styles.strong}>{e.item.title}{e.item.jurisdiction_iso?.length ? <span className={styles.muted}> · {e.item.jurisdiction_iso.join(", ")}</span> : null}</span>
                  <span className={styles.note}>{e.obligation_text}</span>
                  <span className={styles.muted}>{e.source_kind === "claim" ? "From a grounded claim" : e.source_kind === "capture" ? "From the source text" : "From a section"} · {e.confidence} confidence</span>
                </div>
              </div>
            ))
          )
        }
      </Load>
    </Panel>
  );
}
