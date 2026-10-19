"use client";

// New in R2e (M2): the one way an operator act asks for its reason. Every admin act that changes something (pause, hide, stop, re-ground, resolve, triage) carries the operator's own sentence to the database, which refuses a blank one
// and writes it with the act to admin_events. Canned text may be offered as a suggestion; it is never submitted as the reason.
import { useState, type ReactNode } from "react";

import { Button, Dialog } from "@/ui";

import { ReasonField } from "./panel-kit";
import styles from "./admin.module.css";

export interface ReasonRequest {
  title: string;
  /** What will happen, in words (and the count, where there is one). */
  body: ReactNode;
  /** The confirming button's words. */
  action: string;
  /** A phrase to type to confirm a wide act (the whole corpus). */
  phrase?: string;
  /** Text the operator can start from; it counts only once they have edited it. */
  suggestion?: string;
}

function ReasonDialog({ req, onDone }: { req: ReasonRequest; onDone: (reason: string | null) => void }) {
  const [reason, setReason] = useState(req.suggestion ?? "");
  const [typed, setTyped] = useState("");
  const written = reason.trim().length > 0 && reason.trim() !== (req.suggestion ?? "").trim();
  const ready = written && (!req.phrase || typed.trim() === req.phrase);
  return (
    <Dialog open onClose={() => onDone(null)} title={req.title}>
      <div className={styles.stack}>
        <div className={styles.note}>{req.body}</div>
        <ReasonField value={reason} onChange={setReason} hint="Say why, in your own words. It is recorded with who did this and when." />
        {req.phrase ? <ReasonField label={`Type "${req.phrase}" to confirm`} value={typed} onChange={setTyped} /> : null}
        <div className={styles.actions}>
          <Button variant="secondary" onClick={() => onDone(null)}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={() => onDone(reason.trim())}>{req.action}</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** `ask(request)` opens the dialog and resolves with the operator's reason, or null when they cancel; `node` is rendered once by the caller. */
export function useReason() {
  const [open, setOpen] = useState<{ req: ReasonRequest; settle: (reason: string | null) => void } | null>(null);
  const ask = (req: ReasonRequest) => new Promise<string | null>((settle) => setOpen({ req, settle }));
  const node = open ? (
    <ReasonDialog
      req={open.req}
      onDone={(reason) => {
        open.settle(reason);
        setOpen(null);
      }}
    />
  ) : null;
  return { ask, node };
}
