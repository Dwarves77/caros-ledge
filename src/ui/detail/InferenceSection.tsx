// Ported from old_repo/src/components/detail/InferenceSection.tsx (lines 1-69)
// Ported from old_repo/src/components/shared/InferenceClaim.tsx (lines 1-120)
import Link from "next/link";

import { pickVisibleInferences, type InferenceClaimView, type InferenceView } from "@/core/detail/inference-view";
import { statusWord } from "@/core/detail/status-words";

import { TagChip } from "../Chips";
import { SectionCard } from "../SectionCard";
import { StateNote } from "../StateNote";

import { DetailSection } from "./DetailShell";

/** Display admissibility: a refuted claim and a claim that cites nothing are never shown. */
export const admissibleForDisplay = (v: Pick<InferenceClaimView, "statusToken" | "citedItemIds">): boolean => v.statusToken !== "REFUTED" && v.citedItemIds.length > 0;

function InferenceClaim({ v, titles, hrefs }: { v: InferenceClaimView; titles: Record<string, string>; hrefs: Record<string, string> }) {
  return (
    <SectionCard className="cl-inference" dataAttributes={{ "data-figure-kind": "inference", "data-origin-class": v.originClass === "modelled" ? "modelled" : "derived" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-8)" }}>
        {statusWord(v.statusToken) && <TagChip>{statusWord(v.statusToken)}</TagChip>}
        <span className="cl-inference-meta">{v.originClass === "modelled" ? "modelled" : "derived"}</span>
      </div>
      <p style={{ fontSize: "var(--fs-13)", margin: "var(--sp-8) 0 0", overflowWrap: "anywhere" }}>{v.claimText}</p>
      <p className="cl-inference-meta">Confidence {Math.round(v.confidence * 100)}%</p>
      <p className="cl-inference-meta">
        Cited:{" "}
        {v.citedItemIds.map((id, i) => (
          <span key={id}>
            {i > 0 ? ", " : ""}
            {hrefs[id] ? (
              <Link href={hrefs[id]} prefetch={false} className="cl-gfm-a" style={{ display: "inline-flex", alignItems: "center", minHeight: "var(--target)" }}>
                {titles[id] ?? id}
              </Link>
            ) : (
              (titles[id] ?? id)
            )}
          </span>
        ))}
      </p>
    </SectionCard>
  );
}

/** The Inferences section: at most five admissible claims, each with its question in words, status, confidence and citations. Nothing renders when none is admissible. */
export function InferenceSection({ inferences, index, failed = false, onRetry }: { inferences?: InferenceView | null | undefined; index?: number | null | undefined; failed?: boolean; onRetry?: (() => void) | undefined }) {
  if (failed) {
    return (
      <DetailSection id="inferences" title="Inferences" aside="Machine-written, not facts" index={index}>
        <StateNote tone="error" {...(onRetry ? { action: { label: "Retry", onClick: onRetry } } : {})}>
          The inferences did not load.
        </StateNote>
      </DetailSection>
    );
  }
  const visible = pickVisibleInferences(inferences?.claims ?? [], admissibleForDisplay);
  if (visible.length === 0) return null;
  return (
    <DetailSection id="inferences" title="Inferences" aside="Machine-written, not facts" index={index}>
      <div data-guard-container="inferences">
        <StateNote>These are inferences, not facts. Each one shows its status, its confidence and the items it is drawn from.</StateNote>
        {visible.map((v) => (
          <div key={v.id} className="cl-detail-block" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
            {v.questionText && (
              <p data-guard-title style={{ fontSize: "var(--fs-125)", fontWeight: 700, margin: "0 0 var(--sp-6)", color: "var(--ink)" }}>
                Question: {v.questionText}
              </p>
            )}
            <InferenceClaim v={v} titles={inferences?.titles ?? {}} hrefs={inferences?.hrefs ?? {}} />
          </div>
        ))}
      </div>
    </DetailSection>
  );
}
