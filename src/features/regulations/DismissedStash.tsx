"use client";

// Ported from old_repo/src/components/regulations/DismissedStash.tsx (lines 21-120)
// The dismissed regulations behind a closed disclosure, each with Restore. Titles wrap (the old row cut them with an ellipsis). A restore that the server refused is shown, not swallowed.
import { useState } from "react";

import type { Resource } from "@/core/types";
import { Button, MoreBelowDisclosure } from "@/ui";

export function DismissedStash({ dismissed, onRestore }: { dismissed: Resource[]; onRestore: (id: string) => Promise<string | null> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ marginTop: "var(--sp-8)" }}>
      <MoreBelowDisclosure count={dismissed.length} itemNoun="dismissed regulations">
        {error && (
          <p role="alert" className="cl-detail-link-note">
            {error}
          </p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-10)" }}>
          {dismissed.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "var(--sp-12)", alignItems: "center", padding: "var(--sp-10) var(--sp-12)", background: "var(--card)", border: "1px solid var(--line-2)", borderRadius: "var(--sp-4)" }}>
              <div style={{ minWidth: 0 }}>
                <div className="cl-detail-label">{r.jurisdictionIso?.[0] ?? (r.jurisdiction ? r.jurisdiction.toUpperCase() : "GLOBAL")}</div>
                <div data-guard-title style={{ fontSize: "var(--fs-13)", fontWeight: 600, lineHeight: 1.35, overflowWrap: "anywhere" }}>
                  {r.title}
                </div>
              </div>
              <Button  aria-label={`Restore ${r.title}`} onClick={() => void onRestore(r.id).then(setError)}>
                <span aria-hidden="true">↺</span> Restore
              </Button>
            </div>
          ))}
        </div>
      </MoreBelowDisclosure>
    </div>
  );
}
