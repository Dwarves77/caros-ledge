"use client";

// Ported from old_repo/src/components/admin/AdminTableView.tsx (lines 44-120)
// Ported from old_repo/src/components/admin/AdminTableView.tsx (lines 135-267)
// Ported from old_repo/src/components/admin/AdminDashboard.tsx (lines 896-1023)
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { requestJson, type JsonResult } from "@/core/http/request-json";
import { Button, Dialog, ErrorState, FormField, Input, SectionCard, SectionHead, SkeletonListRow, StateNote, Toast } from "@/ui";

import styles from "./admin.module.css";

export interface Fetched<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * One loader for every panel: fetch on mount and on `reload`, one error contract. A failed read is an `error` string, never an empty `data`; a reload keeps the last good data on screen while it runs. A null url loads nothing.
 */
export function useAdminFetch<T>(url: string | null): Fetched<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: url !== null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (url === null) return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the load is the synchronisation with the server
    setState((s) => ({ ...s, loading: true }));
    void requestJson<T>(url).then((r) => {
      if (live) setState({ data: r.ok ? r.data : null, error: r.ok ? null : (r.error ?? "The read failed."), loading: false });
    });
    return () => {
      live = false;
    };
  }, [url, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  // Before the first answer a url that exists is loading, never a failure.
  return { ...state, loading: state.loading || (url !== null && state.data === null && state.error === null), reload };
}

/** The body of a panel that reads: a skeleton while loading, the failure with Retry when the read failed, else the data. Never an empty list standing in for a failure (INV-263). */
export function Load<T>({ q, what, children }: { q: Fetched<T>; what: string; children: (data: T) => ReactNode }) {
  if (q.data !== null) return <>{children(q.data)}</>;
  if (q.loading) return <SkeletonListRow />;
  return <ErrorState title={`${what} did not load`} message={q.error ?? "The read failed."} onRetry={q.reload} />;
}

/** The one timed status: a toast with its outcome. */
export function useFlash(): { show: (text: string, error?: boolean) => void; node: ReactNode } {
  const [flash, setFlash] = useState<{ text: string; error: boolean } | null>(null);
  return {
    show: (text, error = false) => setFlash({ text, error }),
    node: flash ? <Toast visible message={flash.text} variant={flash.error ? "error" : "success"} onDismiss={() => setFlash(null)} /> : null,
  };
}

/**
 * One operator action: the request, a flash with its outcome, and `onDone` on success. `busy` names the key being acted on so its control disables; a request that cannot be sent is a result the screen shows
 * (requestJson never throws), so a control is never left pending.
 */
export function useAct(flash: { show: (t: string, e?: boolean) => void }, onDone?: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  const run = async <T = Record<string, unknown>,>(key: string, path: string, init: { method?: string; body?: unknown }, success: string | ((d: T | null) => string)): Promise<JsonResult<T>> => {
    setBusy(key);
    const r = await requestJson<T>(path, init);
    setBusy(null);
    flash.show(r.ok ? (typeof success === "function" ? success(r.data) : success) : (r.error ?? "The change was not saved."), !r.ok);
    if (r.ok) done.current?.();
    return r;
  };
  return { busy, run };
}

/** A panel: the shared card, its head with a Refresh control, and a body. */
export function Panel({ title, aside, onRefresh, children, id }: { title: string; aside?: ReactNode; onRefresh?: () => void; children: ReactNode; id?: string }) {
  return (
    <SectionCard as="section" aria-label={title} {...(id ? { id } : {})}>
      <SectionHead title={title} aside={onRefresh ? <span className={styles.actions}>{aside}<Button variant="ghost" size="sm" onClick={onRefresh}>Refresh</Button></span> : aside} />
      <div className={styles.body}>{children}</div>
    </SectionCard>
  );
}

/** A destructive action as words, with the phrase typed to confirm (the kit Dialog: Esc, focus kept, focus returned). */
export function ConfirmDialog({ open, title, body, phrase, action, pending, onConfirm, onClose }: { open: boolean; title: string; body: ReactNode; phrase?: string; action: string; pending?: boolean; onConfirm: () => void; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const ready = !phrase || typed.trim() === phrase;
  return (
    <Dialog open={open} onClose={pending ? () => undefined : onClose} title={title}>
      <div className={styles.stack}>
        <div className={styles.note}>{body}</div>
        {phrase ? <FormField label={`Type "${phrase}" to confirm`}>{(c) => <Input {...c} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={phrase} />}</FormField> : null}
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} disabled={!ready || pending}>{pending ? "Working..." : action}</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** A reason field the action needs: required, trimmed, and its refusal shown beside it. */
export function ReasonField({ value, onChange, label = "Reason", hint, error }: { value: string; onChange: (v: string) => void; label?: string; hint?: string; error?: string | null }) {
  return <FormField label={label} required {...(hint ? { hint } : {})} error={error}>{(c) => <Input {...c} value={value} onChange={(e) => onChange(e.target.value)} maxLength={2000} />}</FormField>;
}

/** The failure of a read that is only part of a panel, said once with Retry. */
export const PartFailure = ({ what, error, onRetry }: { what: string; error: string; onRetry?: () => void }) => (
  <StateNote tone="error" {...(onRetry ? { action: { label: "Retry", onClick: onRetry } } : {})}>{what} did not load: {error}</StateNote>
);

/** An honest date at the precision it has: "Mar 4, 2026", or the stable label of an ISO instant; empty input renders nothing. */
export { formatDate as dateOf } from "@/core/shared";
