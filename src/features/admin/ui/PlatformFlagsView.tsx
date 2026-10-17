"use client";

// Ported from old_repo/src/components/admin/PlatformIntegrityFlagsView.tsx (lines 44-119)
// Ported from old_repo/src/components/admin/PlatformIntegrityFlagsView.tsx (lines 121-468)
// Ported from old_repo/src/components/admin/PlatformIntegrityFlagsView.tsx (lines 513-604)
import { useState } from "react";

import { formatLocaleDateTime, formatNumber } from "@/core/shared";
import { Button, EmptyState, FilterChip, FilterChipGroup, FormField, Textarea } from "@/ui";

import { PLATFORM_CATEGORIES, PLATFORM_STATUSES } from "../vocab";

import { Load, Panel, useAct, useAdminFetch, useFlash } from "./panel-kit";
import styles from "./admin.module.css";

type Category = (typeof PLATFORM_CATEGORIES)[number];
type Status = (typeof PLATFORM_STATUSES)[number];
const CATEGORY_LABELS: Record<Category, string> = { design_drift: "Design drift", data_quality: "Data quality", source_issue: "Source issue", coverage_gap: "Coverage gap", data_integrity: "Data integrity", surface_concern: "Surface concern", workflow_gap: "Workflow gap" };
const STATUS_LABELS: Record<Status, string> = { open: "Open", in_review: "In review", resolved: "Resolved", archived: "Archived" };

interface Flag {
  id: string;
  category: Category;
  subject_type: string;
  subject_ref: string;
  description: string;
  recommended_actions: { action: string; rationale?: string }[] | null;
  status: Status;
  created_at: string;
  created_by: string;
  resolved_at: string | null;
  resolution_note: string | null;
}
interface Payload {
  items: Flag[];
  counts: { byCategory: Record<Category, number>; byStatus: Record<Status, number>; total: number };
  page: { offset: number; limit: number; hasMore: boolean };
}

/** The subject in words: a flywheel gap flag names a theme, which has no page of its own, so it is labelled and never linked. Pure. */
export const subjectLabel = (f: Pick<Flag, "subject_type" | "created_by">): string => (f.created_by.startsWith("flywheel-gap:") ? "theme" : f.subject_type);

/** The query for a filter set; status omitted means open and in review. Pure. */
export const flagsQuery = (category: Category | null, status: Status | null, offset: number): string => `/api/admin/integrity-flags?platform=1${category ? `&category=${category}` : ""}${status ? `&status=${status}` : ""}${offset ? `&offset=${offset}` : ""}`;

function FlagRow({ flag, open, onToggle, act }: { flag: Flag; open: boolean; onToggle: () => void; act: ReturnType<typeof useAct> }) {
  const [note, setNote] = useState(flag.resolution_note ?? "");
  const busy = act.busy === flag.id;
  const move = (status: Status, done: string) => act.run(flag.id, "/api/admin/integrity-flags?platform=1", { method: "PATCH", body: { id: flag.id, status, resolution_note: note } }, done);
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <button type="button" className={styles.rowBtn} aria-expanded={open} onClick={onToggle}>
          <span className={styles.rowMain}>
            <span className={styles.actions}><span className={styles.pill}>{CATEGORY_LABELS[flag.category] ?? flag.category}</span><span className={flag.status === "open" ? styles.pillBad : styles.pill}>{STATUS_LABELS[flag.status] ?? flag.status}</span></span>
            <span className={`${styles.note} ${styles.wrap}`}>{flag.description}</span>
          </span>
          <span aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
        {open ? (
          <div className={styles.detail}>
            <p className={styles.muted}>{subjectLabel(flag)}: <span className={styles.mono}>{flag.subject_ref}</span> · raised {formatLocaleDateTime(new Date(flag.created_at))} by {flag.created_by}</p>
            {(flag.recommended_actions ?? []).length ? (
              <ul className={styles.stack}>{(flag.recommended_actions ?? []).map((a, i) => <li key={i} className={styles.note}><b>{a.action}</b>{a.rationale ? `: ${a.rationale}` : ""}</li>)}</ul>
            ) : null}
            <FormField label="Resolution note">{(c) => <Textarea {...c} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />}</FormField>
            <div className={styles.actions}>
              {flag.status !== "in_review" ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => move("in_review", "Marked in review.")}>In review</Button> : null}
              {flag.status !== "resolved" ? <Button variant="primary" size="sm" disabled={busy} onClick={() => move("resolved", "Flag resolved.")}>Resolve</Button> : null}
              {flag.status !== "archived" ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => move("archived", "Flag archived.")}>Archive</Button> : null}
              {flag.status === "resolved" || flag.status === "archived" ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => move("open", "Flag reopened.")}>Reopen</Button> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The platform flags: the agent's own channel. Filter by category and status (open and in review by default), a row opens closed-by-default detail, and the operator answers with a status and a note. Counts are whole-table. */
export function PlatformFlagsView() {
  const [category, setCategory] = useState<Category | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const q = useAdminFetch<Payload>(flagsQuery(category, status, offset));
  const flash = useFlash();
  const act = useAct(flash, q.reload);
  const pick = <T,>(set: (v: T | null) => void, cur: T | null, v: T) => {
    set(cur === v ? null : v);
    setOffset(0);
  };
  return (
    <Panel title="Platform integrity flags" aside={q.data ? `${formatNumber(q.data.counts.total)} in all` : undefined} onRefresh={q.reload}>
      <FilterChipGroup label="Category">
        {PLATFORM_CATEGORIES.map((c) => <FilterChip key={c} active={category === c} onClick={() => pick(setCategory, category, c)}>{CATEGORY_LABELS[c]}{q.data ? ` · ${q.data.counts.byCategory[c]}` : ""}</FilterChip>)}
      </FilterChipGroup>
      <FilterChipGroup label="Status">
        {PLATFORM_STATUSES.map((s) => <FilterChip key={s} active={status === s} onClick={() => pick(setStatus, status, s)}>{STATUS_LABELS[s]}{q.data ? ` · ${q.data.counts.byStatus[s]}` : ""}</FilterChip>)}
      </FilterChipGroup>
      <Load q={q} what="Platform flags">
        {(d) => (
          <>
            {d.items.length === 0 ? <EmptyState>No flags match this filter.</EmptyState> : d.items.map((f) => <FlagRow key={f.id} flag={f} open={open === f.id} onToggle={() => setOpen(open === f.id ? null : f.id)} act={act} />)}
            {d.page.offset > 0 || d.page.hasMore ? (
              <div className={styles.actions}>
                <Button variant="secondary" size="sm" disabled={d.page.offset === 0} onClick={() => setOffset(Math.max(0, d.page.offset - d.page.limit))}>Newer</Button>
                <Button variant="secondary" size="sm" disabled={!d.page.hasMore} onClick={() => setOffset(d.page.offset + d.page.limit)}>Older</Button>
              </div>
            ) : null}
          </>
        )}
      </Load>
      {flash.node}
    </Panel>
  );
}
