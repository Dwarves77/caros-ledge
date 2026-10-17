"use client";

// Ported from old_repo/src/components/sources/SourceAdminControls.tsx (lines 219-400)
import { Button, Switch } from "@/ui";
import { useAct, useFlash } from "@/features/admin/ui/panel-kit";
import styles from "@/features/admin/ui/admin.module.css";

/**
 * The per-source actions in the expanded row (one screen per source): pause processing, hide from workspaces, fetch now (the free direct fetch, refused while the hold is on, and it says so), and ask the next turn
 * to re-capture and re-ground the source's items. Every control is 44 px; one status line says what happened.
 */
export function SourceRowActions({ sourceId, paused, adminOnly, onChanged }: { sourceId: string; paused: boolean; adminOnly: boolean; onChanged: (patch: { processing_paused?: boolean; admin_only?: boolean }) => void }) {
  const flash = useFlash();
  const act = useAct(flash);
  const base = `/api/admin/sources/${encodeURIComponent(sourceId)}`;
  return (
    <div className={styles.stack}>
      <div className={styles.actions}>
        <Switch on={paused} label={paused ? "Resume source processing" : "Pause source processing"} busy={act.busy === "pause"} onChange={async (next) => { const r = await act.run("pause", `${base}/pause`, { method: "POST", body: { paused: next } }, next ? "Processing paused." : "Processing resumed."); if (r.ok) onChanged({ processing_paused: next }); }} />
        <span className={styles.note}>{paused ? "Paused" : "Processing"}</span>
        <Switch on={adminOnly} label={adminOnly ? "Make source visible to workspaces" : "Hide source from workspaces"} busy={act.busy === "visibility"} onChange={async (next) => { const r = await act.run("visibility", `${base}/visibility`, { method: "POST", body: { admin_only: next } }, next ? "Hidden from workspaces." : "Visible to workspaces."); if (r.ok) onChanged({ admin_only: next }); }} />
        <span className={styles.note}>{adminOnly ? "Admin only" : "Visible to workspaces"}</span>
      </div>
      <div className={styles.actions}>
        <Button variant="secondary" size="sm" disabled={act.busy === "fetch"} onClick={() => act.run("fetch", `${base}/fetch-now`, { method: "POST" }, (d) => `Fetched ${(d as { contentLength?: number } | null)?.contentLength ?? 0} characters.`)}>{act.busy === "fetch" ? "Fetching..." : "Fetch now"}</Button>
        <Button variant="secondary" size="sm" disabled={act.busy === "recapture"} onClick={() => act.run("recapture", "/api/admin/corpus-turn-requests", { method: "POST", body: { sourceId } }, (d) => { const x = d as { inserted?: number; already_open?: number } | null; return `Re-capture requested for ${x?.inserted ?? 0} items (${x?.already_open ?? 0} already open).`; })}>Re-capture its items</Button>
      </div>
      {flash.node}
    </div>
  );
}
