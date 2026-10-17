"use client";

// Ported from old_repo/src/components/sources/SourceAdminControls.tsx (lines 402-861)
import { useState } from "react";

import { formatLocaleDateTime } from "@/core/shared";
import { TIER_LABELS } from "@/core/sources/tier-contract";
import { Button, FormField, Select, TierChip } from "@/ui";
import { Load, ReasonField, useAct, useAdminFetch, useFlash } from "@/features/admin/ui/panel-kit";
import styles from "@/features/admin/ui/admin.module.css";

import { SOURCE_TIERS } from "./TierLegend";

interface Audit {
  base_tier: number | null;
  tier_override: number | null;
  effective_tier: number | null;
  override_reason: string | null;
  audit: { event_type: string; reviewer_id: string | null; created_at: string; details: { reason?: string | null; before_tier?: number | null; after_tier?: number | null } }[];
}

/** The reason a set needs, or the refusal in words. Pure. */
export const reasonError = (tier: number | null, reason: string): string | null => (tier !== null && !reason.trim() ? "A reason is required: the operator's knowledge is the record." : null);

/**
 * The source's three tiers (base, effective, override), and the one operator tier path: set an override with a reason, or revert it. Each change writes an audit row naming you; base_tier is never written. The audit list
 * loads when the control opens.
 */
export function TierOverrideControl({ sourceId, onChanged }: { sourceId: string; onChanged: (patch: { tier_override: number | null; override_reason: string | null }) => void }) {
  const [open, setOpen] = useState(false);
  const q = useAdminFetch<Audit>(open ? `/api/admin/sources/${encodeURIComponent(sourceId)}/tier-override` : null);
  const flash = useFlash();
  const act = useAct(flash, q.reload);
  const [tier, setTier] = useState(4);
  const [reason, setReason] = useState("");
  const [showError, setShowError] = useState(false);
  const send = async (next: number | null) => {
    if (reasonError(next, reason)) return setShowError(true);
    const r = await act.run("override", `/api/admin/sources/${encodeURIComponent(sourceId)}/tier-override`, { method: "POST", body: { tier_override: next, override_reason: next === null ? null : reason.trim() } }, next === null ? "Override reverted to the base tier." : `Override set to T${next}.`);
    if (r.ok) {
      setReason("");
      setShowError(false);
      onChanged({ tier_override: next, override_reason: next === null ? null : reason.trim() });
    }
  };
  return (
    <div className={styles.stack}>
      <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide tier controls" : "Tier controls"}</Button>
      {open ? (
        <Load q={q} what="The tier record">
          {(d) => (
            <>
              <p className={styles.actions}>
                {d.base_tier ? <span>Base <TierChip tier={d.base_tier} /></span> : null}
                {d.effective_tier ? <span>Effective <TierChip tier={d.effective_tier} /></span> : null}
                {d.tier_override ? <span>Override <TierChip tier={d.tier_override} /> {d.override_reason ? `(${d.override_reason})` : ""}</span> : <span className={styles.muted}>No override</span>}
              </p>
              <div className={styles.grid2}>
                <FormField label="Override tier">{(c) => <Select {...c} value={tier} onChange={(e) => setTier(Number(e.target.value))}>{SOURCE_TIERS.map((t) => <option key={t} value={t}>T{t} {TIER_LABELS[t]}</option>)}</Select>}</FormField>
                <ReasonField value={reason} onChange={setReason} hint="Why the operator knows better than the class table." error={showError ? reasonError(tier, reason) : null} />
              </div>
              <div className={styles.actions}>
                <Button variant="primary" size="sm" disabled={act.busy === "override"} onClick={() => send(tier)}>Set override</Button>
                {d.tier_override ? <Button variant="secondary" size="sm" disabled={act.busy === "override"} onClick={() => send(null)}>Revert to base tier</Button> : null}
              </div>
              {d.audit.length ? (
                <ul className={styles.stack} aria-label="Override audit">
                  {d.audit.map((a, i) => <li key={i} className={styles.muted}>{formatLocaleDateTime(new Date(a.created_at))}: {a.event_type === "tier_override" ? `set T${a.details.after_tier ?? "?"}` : "reverted"}{a.details.reason ? ` (${a.details.reason})` : ""}</li>)}
                </ul>
              ) : null}
            </>
          )}
        </Load>
      ) : null}
      {flash.node}
    </div>
  );
}
