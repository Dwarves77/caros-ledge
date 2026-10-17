"use client";

// Ported from old_repo/src/components/regulations/DismissedStash.tsx (lines 21-120)
// The dismissed regulations behind a closed disclosure, each with Restore. Titles wrap (the old row cut them with an ellipsis). A restore that the server refused is shown, not swallowed.
import { useState } from "react";

import type { Resource } from "@/core/types";
import { MoreBelowDisclosure } from "@/ui";

export function DismissedStash({ dismissed, onRestore }: { dismissed: Resource[]; onRestore: (id: string) => Promise<string | null> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ marginTop: 8 }}>
      <MoreBelowDisclosure count={dismissed.length} itemNoun="dismissed regulations">
        {error && (
          <p role="alert" className="cl-detail-link-note">
            {error}
          </p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {dismissed.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center", padding: "10px 12px", background: "var(--card)", border: "1px solid var(--line-2)", borderRadius: 4 }}>
              <div style={{ minWidth: 0 }}>
                <div className="cl-detail-label">{r.jurisdictionIso?.[0] ?? (r.jurisdiction ? r.jurisdiction.toUpperCase() : "GLOBAL")}</div>
                <div data-guard-title style={{ fontSize: "var(--fs-13)", fontWeight: 600, lineHeight: 1.35, overflowWrap: "anywhere" }}>
                  {r.title}
                </div>
              </div>
              <button type="button" className="cl-btn cl-btn--secondary cl-btn--md" aria-label={`Restore ${r.title}`} onClick={() => void onRestore(r.id).then(setError)}>
                <span aria-hidden="true">↺</span> Restore
              </button>
            </div>
          ))}
        </div>
      </MoreBelowDisclosure>
    </div>
  );
}
