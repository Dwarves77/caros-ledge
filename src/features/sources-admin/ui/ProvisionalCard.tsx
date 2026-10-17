"use client";

// Ported from old_repo/src/components/sources/ProvisionalReviewCard.tsx (lines 62-178)
import { useState } from "react";

import { requestJson } from "@/core/http/request-json";
import type { AdminProvisional } from "@/features/admin/read/sources";

import { SourceClassificationEditor, type ClassificationDraft, type Decision } from "./SourceClassificationEditor";

/** The body the promote route takes for one decision. Only an approve carries the tier (a tier the class table did not give becomes an override with the note as its reason). Pure. */
export const promoteBody = (id: string, decision: Decision, d: ClassificationDraft) => ({ provisionalSourceId: id, decision, reviewerNotes: d.reviewerNotes || null, ...(decision === "approve" ? { assignedTier: d.assignedTier, domains: d.domains, jurisdictions: d.jurisdictions, transport_modes: d.transport_modes, topic_tags: d.topic_tags } : {}) });

/** The classification editor bound to the provisional decision route. The result (including a partial one) is said to the caller; a row leaves the queue only on success. */
export function ProvisionalCard({ row, busy, onResult }: { row: AdminProvisional; busy: boolean; onResult: (r: { ok: boolean; decision: Decision; message: string }) => void }) {
  const [local, setLocal] = useState(false);
  return (
    <SourceClassificationEditor
      seed={{ name: row.name, url: row.url, tier: row.recommended_tier, biasTags: row.bias_tags }}
      busy={busy || local}
      onDecide={async (decision, draft) => {
        setLocal(true);
        const r = await requestJson<{ sourceId?: string; reused?: boolean }>("/api/admin/sources/promote", { method: "POST", body: promoteBody(row.id, decision, draft) });
        setLocal(false);
        onResult({ ok: r.ok, decision, message: r.ok ? (r.data?.reused ? "Reused the source already in the registry." : decision === "approve" ? "Source approved." : decision === "reject" ? "Rejected." : "Deferred.") : (r.error ?? "The decision was not saved.") });
      }}
    />
  );
}
