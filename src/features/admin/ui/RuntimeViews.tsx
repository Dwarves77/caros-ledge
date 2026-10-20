"use client";

// Ported from old_repo/src/components/admin/ErrorGroupsView.tsx (lines 48-134)
// Ported from old_repo/src/components/admin/AssumptionRegisterPanel.tsx (lines 56-210)
// Ported from old_repo/src/components/admin/InferenceReview.tsx (lines 24-66)
import { formatNumber, formatDate } from "@/core/shared";
import { EmptyState, RelativeTime } from "@/ui";

import { Load, Panel, useAdminFetch } from "./panel-kit";
import styles from "./admin.module.css";

interface ErrorGroup {
  id: string;
  message: string;
  count: number;
  release: string;
  side: string;
  route: string;
  last_seen_at: string;
}
interface Assumption {
  assumption_key: string;
  subsystem: string | null;
  label: string;
  value_numeric: number | null;
  unit: string | null;
  governing_decision: string | null;
  code_location: string;
  status: string;
  as_at_date: string | null;
}
interface Inference {
  inference_id: string;
  subject_id: string | null;
  claim_text: string;
  status_token: string;
  confidence: number | null;
  cited_item_ids: string[] | null;
  trigger_question_ref: string | null;
  computed_at: string;
}

const shortRelease = (r: string): string => (!r || r === "dev" ? "dev" : r.slice(0, 7));
/** The assumptions grouped by subsystem, subsystems sorted. Pure. */
function groupBySubsystem(rows: readonly Assumption[]): [string, Assumption[]][] {
  const m = new Map<string, Assumption[]>();
  for (const r of rows) m.set(r.subsystem || "(unassigned)", [...(m.get(r.subsystem || "(unassigned)") ?? []), r]);
  return [...m].sort(([a], [b]) => a.localeCompare(b));
}

/** First-party runtime errors, grouped: the message, how often, where, which release, when last. Read-only. */
export function ErrorGroupsView() {
  const q = useAdminFetch<{ groups: ErrorGroup[] }>("/api/admin/runtime?view=errors");
  return (
    <Panel title="Runtime errors" aside={q.data ? `${q.data.groups.length} groups · ${formatNumber(q.data.groups.reduce((n, g) => n + g.count, 0))} occurrences` : undefined} onRefresh={q.reload}>
      <Load q={q} what="Runtime errors">
        {(d) =>
          d.groups.length === 0 ? (
            <EmptyState>No runtime errors have been captured.</EmptyState>
          ) : (
            d.groups.map((g) => (
              <div key={g.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={`${styles.strong} ${styles.wrap}`}>{g.message}</span>
                  <span className={styles.muted}>{formatNumber(g.count)}× · {g.side} · {g.route || "no route"} · release {shortRelease(g.release)} · last seen <RelativeTime iso={g.last_seen_at} /></span>
                </div>
              </div>
            ))
          )
        }
      </Load>
    </Panel>
  );
}

/** The assumption register: every constant the platform assumes, with the decision that governs it and where it lives in the code. A row with no ruling says so. */
export function AssumptionRegisterView() {
  const q = useAdminFetch<{ rows: Assumption[] }>("/api/admin/runtime?view=assumptions");
  return (
    <Panel title="Assumption register" aside={q.data ? `${formatNumber(q.data.rows.length)} constants` : undefined} onRefresh={q.reload}>
      <Load q={q} what="The assumption register">
        {(d) =>
          d.rows.length === 0 ? (
            <EmptyState>No assumptions are catalogued yet.</EmptyState>
          ) : (
            groupBySubsystem(d.rows).map(([subsystem, rows]) => (
              <div key={subsystem}>
                <p className={styles.strong}>{subsystem}</p>
                {rows.map((r) => (
                  <div key={r.assumption_key} className={styles.row}>
                    <div className={styles.rowMain}>
                      <b className={styles.strong}>{r.label}</b>
                      <span className={styles.note}>{r.value_numeric ?? "no value"}{r.unit ? ` ${r.unit}` : ""} · {r.governing_decision ?? "no ruling on record"}</span>
                      <span className={`${styles.mono} ${styles.muted}`}>{r.code_location}</span>
                    </div>
                    <span className={styles.muted}>{r.as_at_date ? formatDate(r.as_at_date) : "no as-at date"} · {r.status}</span>
                  </div>
                ))}
              </div>
            ))
          )
        }
      </Load>
    </Panel>
  );
}

/** The current inferences the learning loop wrote: the claim, its status token, confidence and citations with titles. Read-only; written only by the governed drain. */
export function InferenceReview({ rows, itemTitles }: { rows: Inference[]; itemTitles: Record<string, string> }) {
  return rows.length === 0 ? (
    <EmptyState>No inferences have been written yet.</EmptyState>
  ) : (
    <>
      {rows.map((r) => (
        <div key={r.inference_id} className={styles.row}>
          <div className={styles.rowMain}>
            <span className={styles.actions}><span className={r.status_token === "REFUTED" ? styles.pillBad : r.status_token === "CONFIRMED" ? styles.pillOk : styles.pill}>{r.status_token}</span>{r.confidence !== null ? <span className={styles.muted}>confidence {Math.round(r.confidence * 100)}%</span> : null}</span>
            <span className={`${styles.note} ${styles.wrap}`}>{r.claim_text}</span>
            {(r.cited_item_ids ?? []).length ? <ul className={styles.stack}>{(r.cited_item_ids ?? []).map((id) => <li key={id} className={styles.muted}>{itemTitles[id] ?? "an item that could not be read"}</li>)}</ul> : null}
            <span className={styles.muted}>{r.subject_id ? `subject ${r.subject_id} · ` : ""}computed <RelativeTime iso={r.computed_at} />{r.trigger_question_ref ? ` · from question ${r.trigger_question_ref}` : ""}</span>
          </div>
        </div>
      ))}
    </>
  );
}

/** The inferences tab of the console: the same current-rows read as the inferences page. */
export function InferencesView() {
  const q = useAdminFetch<{ rows: Inference[]; itemTitles: Record<string, string> }>("/api/admin/runtime?view=inferences");
  return (
    <Panel title="Inferences" aside={q.data ? `${q.data.rows.length} current` : undefined} onRefresh={q.reload}>
      <Load q={q} what="Inferences">{(d) => <InferenceReview rows={d.rows} itemTitles={d.itemTitles} />}</Load>
    </Panel>
  );
}

interface AdminEvent {
  id: string;
  at: string;
  action: string;
  target_kind: string;
  target_id: string;
  reason: string | null;
  actor: string;
  org: string | null;
}
const words = (token: string): string => token.replaceAll("_", " ");

/** The record of privileged acts (admin_events, written in the same transaction as each change): who did what to what, in which organisation, with the reason they gave, newest first. Read-only; nothing here edits the record. */
export function AdminEventsView() {
  const q = useAdminFetch<{ events: AdminEvent[]; capped: boolean }>("/api/admin/runtime?view=events");
  return (
    <Panel title="Admin events" aside={q.data ? `${formatNumber(q.data.events.length)} newest${q.data.capped ? " (more exist)" : ""}` : undefined} onRefresh={q.reload}>
      <Load q={q} what="The admin event log">
        {(d) =>
          d.events.length === 0 ? (
            <EmptyState>No privileged act has been recorded yet.</EmptyState>
          ) : (
            d.events.map((e) => (
              <div key={e.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <b className={`${styles.strong} ${styles.wrap}`}>{words(e.action)}</b>
                  <span className={`${styles.muted} ${styles.wrap}`}>{e.actor} · {words(e.target_kind)} {e.target_id}{e.org ? ` · ${e.org}` : ""} · <RelativeTime iso={e.at} /></span>
                  {e.reason ? <span className={`${styles.note} ${styles.wrap}`}>{e.reason}</span> : null}
                </div>
              </div>
            ))
          )
        }
      </Load>
    </Panel>
  );
}
