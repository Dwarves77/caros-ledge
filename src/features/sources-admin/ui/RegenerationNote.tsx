"use client";

// Ported from old_repo/src/components/sources/B2RegenerationNote.tsx (lines 22-81)
import { formatNumber } from "@/core/shared";
import { Absence, StateNote } from "@/ui";
import { useAdminFetch } from "@/features/admin/ui/panel-kit";

interface Progress {
  total_eligible: number;
  at_current: number;
  never_regenerated: number;
}

/** Brief regeneration progress as the one state-note strip under the registry tabs. A read that failed says so (it never reads "pending"), and offers Retry. */
export function RegenerationNote({ onOpenQueue }: { onOpenQueue?: () => void }) {
  const q = useAdminFetch<Progress>("/api/admin/b2-progress");
  return (
    <div data-audit="registry-regeneration-note">
      <StateNote tone={q.error ? "error" : "note"} {...(q.error ? { action: { label: "Retry", onClick: q.reload } } : onOpenQueue ? { action: { label: "Open queue", onClick: onOpenQueue } } : {})}>
        <b>Regeneration</b> ·{" "}
        {q.data ? `${formatNumber(q.data.at_current)} / ${formatNumber(q.data.total_eligible)} at the current contract · ${formatNumber(q.data.never_regenerated)} never regenerated` : q.error ? `the count did not load: ${q.error}` : <Absence reason="connect data" />}
      </StateNote>
    </div>
  );
}
