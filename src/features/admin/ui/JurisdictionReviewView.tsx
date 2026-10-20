"use client";

// Ported from old_repo/src/components/admin/PendingJurisdictionReviewView.tsx (lines 59-346)
import { useState } from "react";

import { formatNumber } from "@/core/shared";
import { Button, EmptyState, FormField, Input, RelativeTime } from "@/ui";

import { Load, Panel, useAct, useAdminFetch, useFlash } from "./panel-kit";
import styles from "./admin.module.css";

interface Row {
  id: string;
  current_value: string;
  flagged_reason: string;
  source_column: "jurisdictions" | "jurisdiction_iso";
  flagged_at: string;
  item: { id: string; title: string; jurisdictions: string[] | null; jurisdiction_iso: string[] | null } | null;
}
const REASONS: Record<string, string> = { continent: "A continent, not a jurisdiction", region_bucket: "A region bucket", undefined_group: "A group the vocabulary does not define" };

/** The item's other tokens in the flagged column: the picks that can stand in for the flagged one. Pure. */
const siblingsOf = (r: Pick<Row, "current_value" | "source_column" | "item">): string[] => (r.item?.[r.source_column] ?? []).filter((v) => v !== r.current_value);

/** Jurisdiction tokens the classifier left in review: confirm as is, classify to a code (a sibling is one tap), or drop. The item array and the queue stamp are one atomic write; a resolved row answers a conflict. */
export function JurisdictionReviewView() {
  const q = useAdminFetch<{ items: Row[]; total_unresolved: number; list_capped: boolean }>("/api/admin/triage/pending-jurisdiction-review");
  const flash = useFlash();
  const act = useAct(flash, q.reload);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const resolve = (r: Row, action: "confirm" | "manually-classify" | "dismiss", done: string) => act.run(r.id, "/api/admin/triage/pending-jurisdiction-review", { method: "POST", body: { id: r.id, action, reason: (reasons[r.id] ?? "").trim(), ...(action === "manually-classify" ? { resolution_value: values[r.id] } : {}) } }, done);
  return (
    <Panel title="Jurisdiction review" aside={q.data ? `${formatNumber(q.data.total_unresolved)} unresolved` : undefined} onRefresh={q.reload}>
      <p className={styles.note}>The rules resolve a token first; these are the ones they could not. Confirm keeps the token, classify swaps it for a code, dismiss drops it from the item.</p>
      <Load q={q} what="Jurisdiction review">
        {(d) => (
          <>
            {d.items.length === 0 ? <EmptyState>No jurisdiction token is waiting for review.</EmptyState> : null}
            {d.items.map((r) => {
              const busy = act.busy === r.id;
              const picks = siblingsOf(r);
              const value = values[r.id] ?? "";
              return (
                <div key={r.id} className={styles.row}>
                  <div className={styles.rowMain}>
                    <span className={styles.actions}><span className={styles.pillBad}>{r.current_value}</span><span className={styles.muted}>{REASONS[r.flagged_reason] ?? r.flagged_reason} · in {r.source_column.replace("_", " ")} · <RelativeTime iso={r.flagged_at} /></span></span>
                    <b className={`${styles.strong} ${styles.wrap}`}>{r.item?.title ?? "An item that could not be read"}</b>
                    {picks.length ? (
                      <div className={styles.chips} role="group" aria-label="Other tokens on this item">
                        {picks.map((p) => <Button key={p} variant="secondary" size="sm" onClick={() => setValues({ ...values, [r.id]: p })}>{p}</Button>)}
                      </div>
                    ) : null}
                    <FormField label="Replacement code">{(c) => <Input {...c} value={value} onChange={(e) => setValues({ ...values, [r.id]: e.target.value })} placeholder="DE, US-CA, EU" maxLength={120} />}</FormField>
                    <FormField label="Reason" required hint="Recorded with your decision.">{(c) => <Input {...c} value={reasons[r.id] ?? ""} onChange={(e) => setReasons({ ...reasons, [r.id]: e.target.value })} maxLength={2000} />}</FormField>
                    <div className={styles.actions}>
                      <Button variant="secondary" size="sm" disabled={busy || !(reasons[r.id] ?? "").trim()} onClick={() => resolve(r, "confirm", "Token confirmed.")}>Confirm</Button>
                      <Button variant="primary" size="sm" disabled={busy || !value.trim() || !(reasons[r.id] ?? "").trim()} onClick={() => resolve(r, "manually-classify", `Classified as ${value.trim()}.`)}>Classify</Button>
                      <Button variant="secondary" size="sm" disabled={busy || !(reasons[r.id] ?? "").trim()} onClick={() => resolve(r, "dismiss", "Token dropped from the item.")}>Dismiss</Button>
                    </div>
                  </div>
                </div>
              );
            })}
            {d.list_capped ? <p className={styles.muted}>Showing {d.items.length} of {formatNumber(d.total_unresolved)}.</p> : null}
          </>
        )}
      </Load>
      {flash.node}
    </Panel>
  );
}
