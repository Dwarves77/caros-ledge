"use client";

// Ported from old_repo/src/components/admin/corrections/CorrectionRow.tsx (lines 67-212)
import { useState } from "react";

import { Button, FormField, SectionCard, StateNote, Textarea } from "@/ui";

import styles from "../ui/admin.module.css";

import { describeCorrection, kindLabel, machineValueOf, ORPHAN_EXPLANATION, stateLabel, stateOf } from "./model";
import type { CorrectionData } from "./types";

const SHOW_CHARS = 280;
/** The text a value object carries, first of the known fields. Pure. */
function textOf(value: Record<string, unknown> | null | undefined): string {
  for (const k of ["claim_text", "content_md", "text", "source_span", "relationship"]) {
    const v = value?.[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
const clip = (s: string): string => (s.length > SHOW_CHARS ? `${s.slice(0, SHOW_CHARS)}...` : s);
const dateText = (iso: string | null | undefined): string => (Number.isNaN(Date.parse(iso ?? "")) ? "an unknown date" : new Date(iso as string).toISOString().slice(0, 10));

/** One correction: what it did, its state, the reason, the corrected and machine values, an orphan explanation when it matches nothing now, and a Revoke that asks why and says the machine value comes back. The row never decides what happens next: the owner refetches. */
export function CorrectionRow({ correction: c, onRevoke, itemHref }: { correction: CorrectionData; onRevoke: (c: CorrectionData, reason: string) => Promise<{ ok: boolean; message?: string }>; itemHref?: string }) {
  const state = stateOf(c);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const machine = textOf(machineValueOf(c));
  const corrected = textOf(c.value);
  const confirm = async () => {
    setPending(true);
    setError(null);
    const out = await onRevoke(c, reason);
    setPending(false);
    if (!out.ok) setError(out.message ?? "The revoke did not go through. Try again.");
    else setConfirming(false);
  };
  return (
    <SectionCard as="article" aria-label={describeCorrection(c)} dataAttributes={{ "data-correction-row": c.id }}>
      <div className={styles.body}>
        <div className={styles.actions}>
          <h3 data-guard-title className={styles.strong}>{describeCorrection(c)}</h3>
          <span className={state === "orphaned" ? styles.pillBad : styles.pill}>{stateLabel(state)}</span>
        </div>
        <p className={styles.muted}>{kindLabel(c.target_kind)}{c.item_title ? ` on ${c.item_title}` : ""}. Made {dateText(c.created_at)}{c.created_by ? ` by user ${c.created_by.slice(0, 8)}` : ""}.{c.revoked_at ? ` Revoked ${dateText(c.revoked_at)}${c.revoked_reason ? `: ${c.revoked_reason}` : ""}.` : ""}</p>
        <p className={styles.note}><b>Reason.</b> {c.reason}</p>
        {corrected ? <p className={styles.note}><b>Corrected value.</b> {clip(corrected)}</p> : null}
        {machine ? <p className={styles.note}><b>Machine value.</b> {clip(machine)}</p> : null}
        {state === "orphaned" ? <StateNote tone="error">{ORPHAN_EXPLANATION}</StateNote> : null}
        {itemHref || state !== "revoked" ? (
          <div className={styles.actions}>
            {itemHref ? <a href={itemHref} className={styles.link}>Open item</a> : null}
            {state !== "revoked" && !confirming ? <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>Revoke</Button> : null}
          </div>
        ) : null}
        {confirming ? (
          <div className={styles.detail}>
            <p role="alert" className={styles.note}>Revoking restores the machine value. Customers will see it again straight away.</p>
            <FormField label="Why are you revoking this?" required>{(f) => <Textarea {...f} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending} />}</FormField>
            {error ? <p role="alert" className={styles.note}>{error}</p> : null}
            <div className={styles.actions}>
              <Button variant="danger" size="sm" disabled={pending} onClick={confirm}>{pending ? "Revoking..." : "Revoke and restore machine value"}</Button>
              <Button variant="secondary" size="sm" disabled={pending} onClick={() => { setConfirming(false); setError(null); }}>Keep the correction</Button>
            </div>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
