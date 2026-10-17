"use client";

// Ported from old_repo/src/components/admin/TierOpinionDisagreementsView.tsx (lines 66-181)
// Ported from old_repo/src/components/admin/TierOpinionDisagreementsView.tsx (lines 191-390)
import { useState } from "react";

import { TIER_LABELS } from "@/core/sources/tier-contract";
import { Button, EmptyState, FormField, Input, TierChip } from "@/ui";

import { Load, Panel, useAct, useAdminFetch, useFlash } from "./panel-kit";
import styles from "./admin.module.css";

interface Row {
  source_id: string;
  source_name: string | null;
  source_url: string | null;
  base_tier: number;
  effective_tier: number | null;
  tier_override: number | null;
  override_reason: string | null;
  analyst_tier: number | null;
  opined_tiers: number[];
  opinion_count: number;
  delta: number | null;
}

/** The reason recorded when an operator accepts without writing one: what the evidence was. Pure. */
export const defaultReason = (r: Pick<Row, "opinion_count" | "analyst_tier" | "base_tier">): string => `Disagreement review: ${r.opinion_count} analyst opinions, modal T${r.analyst_tier} vs standing T${r.base_tier}`;

/** Sources whose analyst tier opinions disagree with the standing tier. Accept is a tier override at the analyst tier with its reason, then the opinions are dismissed; reject dismisses them. One tier path, base tier untouched; nothing is deferred. */
export function TierDisagreementsView() {
  const q = useAdminFetch<{ items: Row[] }>("/api/admin/sources/tier-opinions");
  const flash = useFlash();
  const act = useAct(flash, q.reload);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  return (
    <Panel title="Tier disagreements" aside={q.data ? `${q.data.items.length} open` : undefined} onRefresh={q.reload}>
      <p className={styles.note}>Sources where analyst opinions over the last 90 days disagree with the standing tier. Accepting sets an operator override with your reason; the class table&apos;s own opinions never move a tier.</p>
      <Load q={q} what="Tier disagreements">
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState>No source has analyst opinions that disagree with its tier.</EmptyState>
          ) : (
            d.items.map((r) => {
              const busy = act.busy === r.source_id;
              const reason = reasons[r.source_id] ?? "";
              return (
                <div key={r.source_id} className={styles.row}>
                  <div className={styles.rowMain}>
                    <b className={styles.strong}>{r.source_name ?? "A source that could not be read"}</b>
                    {r.source_url ? <a href={r.source_url} target="_blank" rel="noopener noreferrer" className={`${styles.link} ${styles.wrap}`}>{r.source_url}</a> : null}
                    <span className={styles.actions}>
                      <span>Standing <TierChip tier={r.effective_tier ?? r.base_tier} /> {TIER_LABELS[r.effective_tier ?? r.base_tier] ?? ""}</span>
                      {r.analyst_tier !== null ? <span>Analysts <TierChip tier={r.analyst_tier} /> from {r.opinion_count} opinions ({r.opined_tiers.join(", ")})</span> : null}
                      {r.delta !== null ? <span className={styles.pill}>{r.delta > 0 ? "+" : ""}{r.delta}</span> : null}
                    </span>
                    {r.tier_override !== null ? <span className={styles.muted}>Operator override stands: T{r.tier_override}{r.override_reason ? ` (${r.override_reason})` : ""}</span> : null}
                    <FormField label="Reason" hint="Recorded with the decision. Left blank, the evidence is recorded.">{(c) => <Input {...c} value={reason} onChange={(e) => setReasons({ ...reasons, [r.source_id]: e.target.value })} maxLength={2000} />}</FormField>
                    <div className={styles.actions}>
                      <Button variant="primary" size="sm" disabled={busy || r.analyst_tier === null} onClick={() => act.run(r.source_id, "/api/admin/sources/tier-opinions", { method: "POST", body: { source_id: r.source_id, action: "accept", tier: r.analyst_tier, reason: reason.trim() || defaultReason(r) } }, `Accepted: T${r.analyst_tier}.`)}>Accept analyst tier</Button>
                      <Button variant="secondary" size="sm" disabled={busy} onClick={() => act.run(r.source_id, "/api/admin/sources/tier-opinions", { method: "POST", body: { source_id: r.source_id, action: "reject", reason: reason.trim() || null } }, "Opinions dismissed.")}>Reject</Button>
                    </div>
                  </div>
                </div>
              );
            })
          )
        }
      </Load>
      {flash.node}
    </Panel>
  );
}
