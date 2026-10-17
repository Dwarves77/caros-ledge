"use client";

// Ported from old_repo/src/components/regulations/CorridorsAppliedStrip.tsx (lines 1-29)
// Ported from old_repo/src/components/regulations/CorridorsAppliedStripView.tsx (lines 1-95)
// "Corridors this applies on": the corridors whose scope touches this regulation's jurisdictions, each linking to its place on Market Intel. The read is on the page (server, the caller's client);
// nothing renders when no corridor touches the item, and a failed read says so with Retry (the old strip rendered nothing on a failure).
import Link from "next/link";
import { useRouter } from "next/navigation";

import { SectionCard, StateNote } from "@/ui";

export interface CorridorRow {
  entityId: string;
  label: string;
  jurisdictions: ReadonlyArray<{ code: string; name: string | null }>;
}

export function CorridorsApplied({ corridors, failed }: { corridors: ReadonlyArray<CorridorRow>; failed: boolean }) {
  const router = useRouter();
  if (!failed && corridors.length === 0) return null;
  return (
    <div className="cl-detail-wrap" style={{ paddingTop: 16 }} data-guard-container>
      <SectionCard padding="14px 16px">
        <p data-guard-title className="cl-detail-label">
          Corridors this applies on
        </p>
        {failed ? (
          <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>
            The corridors did not load.
          </StateNote>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {corridors.map((c) => (
              <Link key={c.entityId} href={`/market#corridor-${encodeURIComponent(c.entityId)}`} className="cl-detail-link" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, border: "1px solid var(--line-2)", borderRadius: 6, padding: "6px 8px" }}>
                <span style={{ fontSize: "var(--fs-13)", fontWeight: 700, overflowWrap: "anywhere", minWidth: 0 }}>{c.label}</span>
                {c.jurisdictions.map((j) => (
                  <span key={j.code} style={{ fontSize: 10, padding: "2px 7px", border: "1px solid var(--line-2)", borderRadius: 999, background: "var(--page)", color: "var(--ink-2)", fontWeight: 700 }}>
                    {j.name ? `${j.name} (${j.code})` : j.code}
                  </span>
                ))}
                <span style={{ marginLeft: "auto", fontSize: "var(--fs-11)", color: "var(--ink-3)" }}>View on Market Intel &rarr;</span>
              </Link>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
