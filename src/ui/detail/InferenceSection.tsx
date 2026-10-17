// Ported from old_repo/src/components/detail/InferenceSection.tsx (lines 1-69)
// Ported from old_repo/src/components/shared/InferenceClaim.tsx (lines 1-120)
import Link from "next/link";

import { pickVisibleInferences, type InferenceClaimView, type InferenceView } from "@/core/detail/inference-view";

import { TagChip } from "../Chips";
import { SectionCard } from "../SectionCard";
import { StateNote } from "../StateNote";

import { DetailSection } from "./DetailShell";

/** The status token in words (INV-272): a customer never reads CONFIRMED or HYPOTHESIS as code. */
const STATUS_WORDS: Record<string, string> = { CONFIRMED: "Confirmed", HYPOTHESIS: "Hypothesis", REFUTED: "Refuted" };

/** Display admissibility: a refuted claim and a claim that cites nothing are never shown. */
export const admissibleForDisplay = (v: Pick<InferenceClaimView, "statusToken" | "citedItemIds">): boolean => v.statusToken !== "REFUTED" && v.citedItemIds.length > 0;

function InferenceClaim({ v, titles, hrefs }: { v: InferenceClaimView; titles: Record<string, string>; hrefs: Record<string, string> }) {
  return (
    <SectionCard className="cl-inference" dataAttributes={{ "data-figure-kind": "inference", "data-origin-class": v.originClass === "modelled" ? "modelled" : "derived" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <TagChip>{STATUS_WORDS[v.statusToken] ?? v.statusToken}</TagChip>
        <span className="cl-inference-meta">{v.originClass === "modelled" ? "modelled" : "derived"}</span>
      </div>
      <p style={{ fontSize: "var(--fs-13)", margin: "8px 0 0", overflowWrap: "anywhere" }}>{v.claimText}</p>
      <p className="cl-inference-meta">Confidence {Math.round(v.confidence * 100)}%</p>
      <p className="cl-inference-meta">
        Cited:{" "}
        {v.citedItemIds.map((id, i) => (
          <span key={id}>
            {i > 0 ? ", " : ""}
            {hrefs[id] ? (
              <Link href={hrefs[id]} className="cl-gfm-a" style={{ display: "inline-flex", alignItems: "center", minHeight: 44 }}>
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
export function InferenceSection({ inferences, index }: { inferences?: InferenceView | null | undefined; index?: number | null | undefined }) {
  const visible = pickVisibleInferences(inferences?.claims ?? [], admissibleForDisplay);
  if (visible.length === 0) return null;
  return (
    <DetailSection id="inferences" title="Inferences" aside="Machine-written, not facts" index={index}>
      <div data-guard-container="inferences">
        <StateNote>These are inferences, not facts. Each one shows its status, its confidence and the items it is drawn from.</StateNote>
        {visible.map((v) => (
          <div key={v.id} className="cl-detail-block" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
            {v.questionText && (
              <p data-guard-title style={{ fontSize: "var(--fs-125)", fontWeight: 700, margin: "0 0 6px", color: "var(--ink)" }}>
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
