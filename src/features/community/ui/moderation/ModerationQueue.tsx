"use client";

// Ported from old_repo/src/components/community/ModerationQueue.tsx (lines 83-614)
// The moderation queue: the reports you can see (the ones you filed, those on posts in groups you moderate, every report for a platform admin), filtered by status and reason IN the query, paged with an honest
// cursor ("Show more reports"), each with its post, the reporter's words and, once closed, what was done. Action buttons appear only where the caller may act (the route says so per report). A failed load or page says so with
// Retry; the toast is the layout's one.
import { useCallback, useEffect, useState } from "react";

import { Button, EmptyState, FormField, Segmented, Select, StateNote } from "@/ui";
import { RelativeTime } from "@/ui";

import { communityApi } from "../../lib/api";
import { REPORT_REASONS, REPORT_REASON_SHORT } from "../../lib/labels";
import type { ModerationReportView } from "../../lib/types";
import styles from "../community.module.css";

import { ModerationActions } from "./ModerationActions";

type Status = "open" | "resolved" | "dismissed" | "all";
const STATUSES = [
  { id: "open", label: "Open" },
  { id: "resolved", label: "Resolved" },
  { id: "dismissed", label: "Dismissed" },
  { id: "all", label: "All" },
] as const;
const ACTION_WORDS: Record<string, string> = { dismiss: "Dismissed", warn: "Author warned", remove: "Post removed", mute: "Muted", ban: "Author banned from the group" };

export function ModerationQueue() {
  const [status, setStatus] = useState<Status>("open");
  const [reason, setReason] = useState("");
  const [reports, setReports] = useState<ModerationReportView[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "idle" | "failed">("loading");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(
    async (before: string | null) => {
      setPhase("loading");
      const r = await communityApi.reports({ ...(status === "all" ? {} : { status }), ...(reason ? { reason } : {}), before });
      if (!r.ok || !r.data) return setPhase("failed");
      const page = r.data;
      setReports((cur) => [...(before ? (cur ?? []) : []), ...page.reports]);
      setNext(page.next_cursor);
      setPhase("idle");
    },
    [status, reason],
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the load is the synchronisation with the server
    setReports(null);
    void load(null);
  }, [load]);

  const closed = (id: string) => {
    setExpanded(null);
    if (status === "open") setReports((cur) => (cur ?? []).filter((r) => r.id !== id));
    else void load(null);
  };

  return (
    <div className={styles.stack}>
      <div className={styles.filters}>
        <Segmented label="Report status" options={STATUSES} selected={[status]} onSelect={setStatus} />
        <FormField label="Reason">
          {(c) => (
            <Select {...c} value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">All reasons</option>
              {REPORT_REASONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.short}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>
      {reports === null && phase === "loading" && <p className={styles.muted}>Loading reports…</p>}
      {reports === null && phase === "failed" && (
        <StateNote tone="error" action={{ label: "Retry", onClick: () => void load(null) }}>
          The reports could not be loaded. Nothing has been lost.
        </StateNote>
      )}
      {reports && reports.length === 0 && <EmptyState>No {status === "all" ? "" : `${status} `}reports{reason ? ` for that reason` : ""}.</EmptyState>}
      {reports?.map((r) => (
        <article key={r.id} className={styles.report}>
          <header className={styles.chipRow}>
            <span className={styles.chip}>{REPORT_REASON_SHORT[r.reason ?? "other"] ?? "Other"}</span>
            <span className={`${styles.chip} ${r.status === "open" ? styles.chipStrong : ""}`}>{r.status === "open" ? "Open" : r.status === "resolved" ? "Resolved" : "Dismissed"}</span>
            {r.group_name && <span className={styles.muted}>{r.group_name}</span>}
            <span className={styles.muted}><RelativeTime iso={r.created_at} /></span>
            {r.is_mine && <span className={styles.muted}>You reported this</span>}
          </header>
          {r.post ? (
            <>
              {r.post.title && <p className={styles.strong}>{r.post.title}</p>}
              <p className={styles.body}>{r.post.excerpt}</p>
            </>
          ) : (
            <p className={styles.muted}>The reported item is no longer available.</p>
          )}
          {r.body && <p className={styles.body}>Reporter: {r.body}</p>}
          {r.status !== "open" && (
            <p className={styles.muted}>
              {ACTION_WORDS[r.action ?? "dismiss"] ?? "Closed"}
              {r.notes ? `: ${r.notes}` : ""}
            </p>
          )}
          {r.status === "open" && r.can_review && (
            <>
              <Button variant="secondary" size="sm" aria-expanded={expanded === r.id} onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                {expanded === r.id ? "Close" : "Take action"}
              </Button>
              {expanded === r.id && <ModerationActions reportId={r.id} onResolved={() => closed(r.id)} />}
            </>
          )}
        </article>
      ))}
      {reports && phase === "failed" && (
        <StateNote tone="error" action={{ label: "Retry", onClick: () => void load(next) }}>
          More reports could not be loaded.
        </StateNote>
      )}
      {reports && next && phase !== "failed" && (
        <Button variant="secondary" disabled={phase === "loading"} onClick={() => void load(next)}>
          {phase === "loading" ? "Loading…" : "Show more reports"}
        </Button>
      )}
    </div>
  );
}
