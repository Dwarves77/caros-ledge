"use client";

// Ported from old_repo/src/components/admin/IntegrityFlagsView.tsx (lines 65-99)
// Ported from old_repo/src/components/admin/IntegrityFlagsView.tsx (lines 101-151)
// Ported from old_repo/src/components/admin/IntegrityFlagsView.tsx (lines 153-389)
import Link from "next/link";
import { useState } from "react";

import { formatDate, formatNumber } from "@/core/shared";
import { Button, EmptyState, FormField, Input, StatBlock, TierChip } from "@/ui";

import { Load, Panel, useAct, useAdminFetch, useFlash } from "./panel-kit";
import { useReason } from "./reason-dialog";
import styles from "./admin.module.css";

interface FlagItem {
  id: string;
  legacyId: string | null;
  title: string | null;
  sourceUrl: string | null;
  sourceName: string | null;
  sourceTier: number | null;
  phrase: string | null;
  flaggedAt: string | null;
}
interface FlagsPayload {
  items: FlagItem[];
  stats: { totalUnresolved: number; totalFlagged: number; shown: number; capped: boolean };
}

/** Whole days since an instant, from the request's own clock reading. Pure. */
const ageDays = (iso: string | null, nowMs: number): number | null => (iso ? Math.max(0, Math.round((nowMs - Date.parse(iso)) / 86_400_000)) : null);

/**
 * Per-brief integrity flags: briefs whose agent could not verify the source. An operator may resolve (with a reason), replace the source address (stored canonical, with a reason), or ask for a re-capture, which opens
 * one manual turn request for the item: the machine fetches and re-grounds it and the outcome is in the harness ledger. Nothing here runs a model.
 */
export function BriefFlagsView({ nowMs }: { nowMs: number }) {
  const q = useAdminFetch<FlagsPayload>("/api/admin/integrity-flags");
  const flash = useFlash();
  const act = useAct(flash, q.reload);
  const why = useReason();
  const [urls, setUrls] = useState<Record<string, string>>({});
  return (
    <Panel title="Agent integrity flags" aside={q.data ? `${formatNumber(q.data.stats.totalUnresolved)} unresolved` : undefined} onRefresh={q.reload}>
      <p className={styles.note}>Briefs where the agent reported it could not verify the source address, or the source did not match the request. An operator may resolve each one.</p>
      <Load q={q} what="Integrity flags">
        {(d) => {
          const oldest = ageDays(d.items[0]?.flaggedAt ?? null, nowMs);
          return (
            <>
              <div className={styles.grid3}>
                <StatBlock label="Unresolved" value={formatNumber(d.stats.totalUnresolved)} tone={d.stats.totalUnresolved > 0 ? "critical" : "default"} />
                <StatBlock label="All-time flagged" value={formatNumber(d.stats.totalFlagged)} />
                <StatBlock label="Oldest unresolved" value={oldest === null ? "none" : `${oldest}d`} tone={(oldest ?? 0) >= 7 ? "critical" : "default"} />
              </div>
              {d.items.length === 0 ? <EmptyState>No unresolved integrity flags. New ones appear here when the integrity rule fires.</EmptyState> : null}
              {d.items.map((r) => {
                const busy = act.busy === r.id;
                const url = urls[r.id] ?? "";
                return (
                  <div key={r.id} className={styles.row}>
                    <div className={styles.rowMain}>
                      <b className={styles.strong}>{r.title || "(untitled)"}</b>
                      <span className={styles.muted}>{r.legacyId || r.id.slice(0, 8)} · flagged {r.flaggedAt ? formatDate(r.flaggedAt.slice(0, 10)) : "date unknown"}</span>
                      <span className={styles.note}>{r.sourceName || "No registry source"}{r.sourceTier ? <> <TierChip tier={r.sourceTier} /></> : null}</span>
                      {r.sourceUrl ? <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer" className={`${styles.link} ${styles.wrap}`}>{r.sourceUrl}</a> : null}
                      <code className={styles.mono}>{r.phrase || "no phrase recorded"}</code>
                      <FormField label="Replacement source address">{(c) => <Input {...c} type="url" value={url} onChange={(e) => setUrls((s) => ({ ...s, [r.id]: e.target.value }))} placeholder="https://" disabled={busy} />}</FormField>
                      <div className={styles.actions}>
                        <Link href={`/regulations/${encodeURIComponent(r.legacyId || r.id)}`} target="_blank" className="cl-btn cl-btn--secondary cl-btn--sm">View brief</Link>
                        <Button variant="secondary" size="sm" disabled={busy} onClick={async () => { const reason = await why.ask({ title: "Request a re-capture", body: "The next turn fetches and re-grounds this item.", action: "Request re-capture" }); if (reason) await act.run(r.id, "/api/admin/corpus-turn-requests", { method: "POST", body: { itemId: r.id, reason } }, (x) => ((x as { already_open?: boolean } | null)?.already_open ? "A re-capture is already open for this item." : "Re-capture requested: the next turn fetches and re-grounds it.")); }}>Re-capture</Button>
                        <Button variant="secondary" size="sm" disabled={busy} onClick={async () => { const reason = await why.ask({ title: "Mark this flag resolved", body: "The flag leaves the queue. Say what you checked.", action: "Mark resolved" }); if (reason) await act.run(r.id, `/api/admin/integrity-flags/${encodeURIComponent(r.id)}/resolve`, { method: "POST", body: { action: "mark_resolved", reason } }, "Flag marked resolved."); }}>Mark resolved</Button>
                        <Button variant="primary" size="sm" disabled={busy || !/^https?:\/\//.test(url)} onClick={async () => { const reason = await why.ask({ title: "Replace the source address", body: <>The address becomes <b className={styles.wrap}>{url}</b> and the flag is resolved.</>, action: "Replace and resolve" }); if (reason) await act.run(r.id, `/api/admin/integrity-flags/${encodeURIComponent(r.id)}/resolve`, { method: "POST", body: { action: "replace_url", newSourceUrl: url, reason } }, "Source address replaced and the flag resolved."); }}>Replace address</Button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {d.stats.capped ? <p className={styles.muted}>Showing the oldest {d.stats.shown} of {formatNumber(d.stats.totalUnresolved)}.</p> : null}
            </>
          );
        }}
      </Load>
      {flash.node}
      {why.node}
    </Panel>
  );
}
