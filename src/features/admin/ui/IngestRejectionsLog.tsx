"use client";

// Ported from old_repo/src/components/admin/IngestRejectionsView.tsx (lines 54-337)
import { useState } from "react";

import { formatNumber } from "@/core/shared";
import { Button, EmptyState, FormField, RelativeTime, StatBlock, Textarea } from "@/ui";

import { REJECTION_ACTIONS } from "../vocab";

import { Load, Panel, useAct, useAdminFetch, useFlash } from "./panel-kit";
import styles from "./admin.module.css";

interface Rejection {
  id: string;
  raw_value: string;
  rejection_reason: string;
  source_url: string | null;
  ingest_attempted_at: string;
  source: { name?: string | null; url?: string | null } | null;
}
interface Payload {
  items: Rejection[];
  total_untriaged: number;
  list_capped: boolean;
}
const REASONS: Record<string, string> = { below_granularity: "Below the granularity the ledger tracks", non_geographic: "Not a place", institutional: "An institution, not a place", unparseable: "Could not be parsed" };
const ACTION_LABELS: Record<(typeof REJECTION_ACTIONS)[number], string> = { discarded: "Discard", reclassified: "Reclassify", escalated: "Escalate" };

/** Jurisdiction tokens the trigger could not normalise. The operator stamps each triaged (who, when, which, a note); a stamp changes no item, and the token re-enters only through intake. */
export function IngestRejectionsLog() {
  const q = useAdminFetch<Payload>("/api/admin/triage/ingest-rejections");
  const flash = useFlash();
  const act = useAct(flash, q.reload);
  const [notes, setNotes] = useState<Record<string, string>>({});
  return (
    <Panel title="Ingest rejections" aside={q.data ? `${formatNumber(q.data.total_untriaged)} untriaged` : undefined} onRefresh={q.reload}>
      <p className={styles.note}>Jurisdiction tokens the trigger could not normalise. Triaging records your decision; it does not edit any item.</p>
      <Load q={q} what="Ingest rejections">
        {(d) => (
          <>
            <StatBlock label="Untriaged" value={formatNumber(d.total_untriaged)} note={d.list_capped ? `Showing the newest ${d.items.length}` : undefined} />
            {d.items.length === 0 ? <EmptyState>Nothing is waiting for triage.</EmptyState> : null}
            {d.items.map((r) => (
              <div key={r.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <b className={`${styles.strong} ${styles.wrap}`}>{r.raw_value}</b>
                  <span className={styles.muted}>{REASONS[r.rejection_reason] ?? r.rejection_reason} · <RelativeTime iso={r.ingest_attempted_at} />{r.source?.name ? ` · ${r.source.name}` : ""}</span>
                  {r.source_url ? <a href={r.source_url} target="_blank" rel="noopener noreferrer" className={`${styles.link} ${styles.wrap}`}>{r.source_url}</a> : null}
                  <FormField label="Note">{(c) => <Textarea {...c} rows={2} value={notes[r.id] ?? ""} onChange={(e) => setNotes((s) => ({ ...s, [r.id]: e.target.value }))} maxLength={2000} />}</FormField>
                  <div className={styles.actions}>
                    {REJECTION_ACTIONS.map((a) => (
                      <Button key={a} variant="secondary" size="sm" disabled={act.busy === r.id} onClick={() => act.run(r.id, "/api/admin/triage/ingest-rejections", { method: "POST", body: { id: r.id, action: a, notes: notes[r.id] ?? null } }, `Marked ${a}.`)}>{ACTION_LABELS[a]}</Button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </Load>
      {flash.node}
    </Panel>
  );
}
