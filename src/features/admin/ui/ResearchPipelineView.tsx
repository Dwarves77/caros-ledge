"use client";

// Ported from old_repo/src/components/admin/ResearchPipelineQueueView.tsx (lines 66-101)
// Ported from old_repo/src/components/admin/ResearchPipelineQueueView.tsx (lines 108-283)
import Link from "next/link";

import { formatNumber } from "@/core/shared";
import { SURFACE_LABELS, SURFACE_PATH } from "@/core/routing/surface";
import { EmptyState } from "@/ui";

import { Load, Panel, useAdminFetch } from "./panel-kit";
import styles from "./admin.module.css";

interface Draft {
  id: string;
  legacy_id: string | null;
  title: string;
  summary: string | null;
  severity: string | null;
  added_date: string | null;
  agent_integrity_flag: boolean | null;
  provenance_status: string | null;
  surface: string;
  source: { name: string | null } | null;
}

/** The machine status of an item the gates are still holding, in words: it is customer-visible only once provenance_status is verified, and no person publishes it. Pure. */
const statusWords = (d: Pick<Draft, "provenance_status" | "agent_integrity_flag">): string => `${d.provenance_status ? d.provenance_status.replace(/_/g, " ") : "in the pipeline"}${d.agent_integrity_flag ? " · integrity flag raised" : ""}`;

/** Items the machine gates are still holding, each with the surface it joins once they pass. Visibility only: nothing here publishes. One column at every width. */
export function ResearchPipelineView() {
  const q = useAdminFetch<{ items: Draft[]; total: number; capped: boolean }>("/api/admin/pipeline/drafts");
  return (
    <Panel title="Pipeline" aside={q.data ? `${formatNumber(q.data.total)} held` : undefined} onRefresh={q.reload}>
      <p className={styles.note}>Machine-pipeline visibility. An item reaches customers when its provenance status is verified; there is no human publish.</p>
      <Load q={q} what="The pipeline">
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState>Nothing is being held by the gates.</EmptyState>
          ) : (
            <>
              {d.items.map((i) => {
                const base = SURFACE_PATH[i.surface];
                return (
                  <div key={i.id} className={styles.row}>
                    <div className={styles.rowMain}>
                      <b className={`${styles.strong} ${styles.wrap}`}>{i.title}</b>
                      <span className={styles.muted}>{SURFACE_LABELS[i.surface] ?? i.surface} · {i.source?.name ?? "no registry source"}{i.added_date ? ` · added ${i.added_date}` : ""}</span>
                      {i.summary ? <span className={styles.note}>{i.summary}</span> : null}
                      <span className={styles.actions}><span className={i.agent_integrity_flag ? styles.pillBad : styles.pill}>{statusWords(i)}</span>{base ? <Link href={`${base}/${encodeURIComponent(i.legacy_id || i.id)}`} target="_blank" className={styles.link}>View as customer</Link> : null}</span>
                    </div>
                  </div>
                );
              })}
              {d.capped ? <p className={styles.muted}>Showing the newest {d.items.length} of {formatNumber(d.total)}.</p> : null}
            </>
          )
        }
      </Load>
    </Panel>
  );
}
