"use client";

// Ported from old_repo/src/components/sources/ProvisionalReviewTable.tsx (lines 38-385)
import { useState } from "react";

import { requestJson } from "@/core/http/request-json";
import { formatNumber, hostOf } from "@/core/shared";
import { classTierForHost } from "@/core/sources/host-class";
import type { AdminProvisional } from "@/features/admin/read/sources";
import { EmptyState, InlineErrorBanner, RelativeTime, RowTable, RowTableAction, SourceLink, StateNote, TierChip } from "@/ui";
import { useFlash } from "@/features/admin/ui/panel-kit";
import { useReason } from "@/features/admin/ui/reason-dialog";
import styles from "@/features/admin/ui/admin.module.css";

import { ProvisionalCard, promoteBody } from "./ProvisionalCard";

const STATUS_WORDS: Record<string, string> = { pending_review: "Provisional", needs_more_data: "Needs data" };
const COLUMNS = [{ label: "Source", width: "minmax(220px, 1fr)" }, { label: "Tier", width: "56px" }, { label: "Status", width: "120px" }, { label: "Discovered", width: "120px" }, { label: "", width: "110px" }, { label: "", width: "96px" }];

/** The tier a row would be approved at: the class table's for its host and name, else the recommendation stored with it, else nothing (a tier is never invented). Pure. */
const rowTier = (r: Pick<AdminProvisional, "url" | "name" | "recommended_tier">): number | null => classTierForHost(hostOf(r.url), r.name) ?? r.recommended_tier;

/**
 * The provisional review queue: the sources the machine could not place on its own, an override surface (the gates already ruled on everything they could). A row approves at its class tier in one tap, or opens the
 * full editor. The head count is the same queue the badge counts (COUNTS-61); a row leaves only when the decision succeeded.
 */
export function ProvisionalQueue({ rows, pendingTotal, stagedCount, onOpenStaged, onRemoved }: { rows: AdminProvisional[]; pendingTotal: number | null; stagedCount: number; onOpenStaged: () => void; onRemoved: (id: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flash = useFlash();
  const why = useReason();
  const done = (id: string, r: { ok: boolean; decision: string; message: string }) => {
    setBusy(null);
    flash.show(r.message, !r.ok);
    setError(r.ok ? null : r.message);
    if (r.ok && r.decision !== "defer") onRemoved(id);
  };
  const quick = async (r: AdminProvisional, tier: number) => {
    const reason = await why.ask({ title: `Approve ${r.name} at T${tier}`, body: "The source joins the registry at this tier.", action: `Approve T${tier}` });
    if (!reason) return;
    setBusy(r.id);
    const res = await requestJson("/api/admin/sources/promote", { method: "POST", body: promoteBody(r.id, "approve", { assignedTier: tier, domains: [], jurisdictions: [], transport_modes: [], topic_tags: [], reviewerNotes: reason }) });
    done(r.id, { ok: res.ok, decision: "approve", message: res.ok ? "Source approved." : (res.error ?? "The decision was not saved.") });
  };
  return (
    <div className={styles.stack}>
      <StateNote action={{ label: "Open staged updates", onClick: onOpenStaged }}>{formatNumber(stagedCount)} staged updates are passing through the gates. Everything below is a source they could not place on their own.</StateNote>
      <p className={styles.note}>{formatNumber(pendingTotal ?? rows.length)} in the queue{pendingTotal !== null && pendingTotal !== rows.length ? ` (${formatNumber(rows.length)} shown)` : ""}.</p>
      {error ? <InlineErrorBanner message={error} /> : null}
      {rows.length === 0 ? (
        <EmptyState>The provisional queue is empty. Nothing is waiting on an operator.</EmptyState>
      ) : (
        <RowTable
          columns={COLUMNS}
          rows={rows.map((r) => {
            const tier = rowTier(r);
            return {
              key: r.id,
              cells: [
                <span key="s" className={styles.cell}><b className={styles.strong}>{r.name}</b><br /><SourceLink href={r.url}>{hostOf(r.url) || r.url}</SourceLink></span>,
                tier ? <TierChip key="t" tier={tier} /> : <span key="t" className={styles.muted} title="The class table does not place this host">not placed</span>,
                <span key="st" className={styles.pill}>{STATUS_WORDS[r.status] ?? r.status}</span>,
                <RelativeTime key="d" iso={r.created_at} />,
                <RowTableAction key="a" label={tier ? `Approve T${tier}` : "Choose tier"} disabled={busy === r.id} onClick={() => (tier ? quick(r, tier) : setOpen(r.id))} />,
                <RowTableAction key="o" label={open === r.id ? "Close" : "Review"} onClick={() => setOpen(open === r.id ? null : r.id)} />,
              ],
              ...(open === r.id ? { below: <ProvisionalCard row={r} busy={busy === r.id} onResult={(x) => done(r.id, x)} /> } : {}),
            };
          })}
        />
      )}
      {flash.node}
      {why.node}
    </div>
  );
}
