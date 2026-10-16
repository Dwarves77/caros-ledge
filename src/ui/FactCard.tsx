"use client";

// Ported from old_repo/src/components/ui/FactCard.tsx (lines 31-204, 227-348, 365-660)
import { createContext, useContext, type ReactNode } from "react";

import { hostOf } from "@/core/shared";

import { Absence } from "./Absence";
import { TierChip } from "./Chips";
import { sixWordHeadline, sourceNameWrapsToTwoLines, withClaimTiers, type ClaimNode, type ClaimTierMap, type FactCardModel, type FactCardProvenance, type MatrixFact } from "./claim-tier";
import { SourceLink } from "./SmallParts";

const ClaimTierContext = createContext<ClaimTierMap | null>(null);

/** The surface's claim-tier map (COALESCE(tier_override, base_tier) per grounded claim); every FactCard below reads it. */
export const ClaimTierProvider = ({ claimTiers, children }: { claimTiers?: ClaimTierMap | null; children: ReactNode }) => <ClaimTierContext.Provider value={claimTiers ?? null}>{children}</ClaimTierContext.Provider>;

const ORANGE_KINDS = new Set(["ACTION REQUIRED", "LEGAL CONFIRMATION REQUIRED"]);
const INFERENCE_KIND = "ANALYTICAL INFERENCE";
const formFor = (kind: string): "orange" | "ink" | "inference" => (kind === INFERENCE_KIND ? "inference" : ORANGE_KINDS.has(kind) ? "orange" : "ink");

function Claim({ nodes }: { nodes: ClaimNode[] }) {
  return nodes.map((n, i) =>
    n.href ? (
      <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="cl-fc-inline-link">
        {n.text}
      </a>
    ) : n.bold ? (
      <strong key={i}>{n.text}</strong>
    ) : (
      <span key={i}>{n.text}</span>
    ),
  );
}

const TierAbsence = () => (
  <span data-part-slot="tier-absence" className="cl-fc-tier-absence">
    <Absence reason="not in primary source" variant="dash" />
  </span>
);

function ProvenanceBlock({ provenance: p, inference }: { provenance?: FactCardProvenance | null | undefined; inference?: boolean }) {
  if (inference) return <p className="cl-fc-prov-text cl-fc-prov-text--italic">not citable</p>;
  if (!p || (!p.source && !p.org && !p.href && !p.accessed && p.tier == null)) {
    return (
      <p className="cl-fc-prov-text cl-fc-prov-line">
        <TierAbsence />
      </p>
    );
  }
  return (
    <>
      <p className="cl-fc-prov-text cl-fc-prov-line">
        {typeof p.tier === "number" ? <TierChip tier={p.tier} size="square" /> : <TierAbsence />}
        {p.source && <span>{p.source}</span>}
      </p>
      {p.org && !sourceNameWrapsToTwoLines(p.source) && <p className="cl-fc-prov-text">{p.org}</p>}
      {p.href && (
        <a href={p.href} target="_blank" rel="noopener noreferrer" className="cl-fc-prov-link">
          {hostOf(p.href)} <span aria-hidden="true">&#8599;</span>
        </a>
      )}
      {p.accessed && <p className="cl-fc-prov-text">{p.accessed}</p>}
    </>
  );
}

function MatrixBody({ fact: f }: { fact: MatrixFact }) {
  return (
    <div data-audit="ops-fact-card" data-part="fact-card" data-kind="matrix" className="cl-fc-matrix">
      <div className="cl-fc-matrix-lead">
        {f.figure ? (
          <span data-audit="ops-fact-figure" data-guard-display="matrix-fact-figure" className="cl-fc-matrix-figure">
            {f.figure}
          </span>
        ) : (
          <span data-audit="ops-fact-headline" className="cl-fc-matrix-headline">
            {sixWordHeadline(f.headline)}
          </span>
        )}
        {f.claim && (
          <span data-audit="ops-fact-quote" className="cl-fc-matrix-claim">
            {f.claim}
          </span>
        )}
        {f.indexVsBase !== null && <span className="cl-fc-matrix-index">index {Math.round(f.indexVsBase)} vs base</span>}
      </div>
      {f.prose && (
        <p data-audit="ops-fact-detail" className="cl-fc-matrix-prose">
          {f.prose}
        </p>
      )}
      <div data-audit="ops-fact-source" className="cl-fc-matrix-source">
        <span className="cl-fc-matrix-tier">{f.sourceTier != null ? <TierChip tier={f.sourceTier} size="square" /> : <TierAbsence />}</span>
        {f.sourceName ? f.sourceUrl ? <SourceLink href={f.sourceUrl}>{f.sourceName}</SourceLink> : f.sourceName : "source not linked"}
        {f.period ? ` · ${f.period}` : ""}
        {f.provenance ? ` · ${f.provenance}` : f.written ? ` · row written ${f.written}` : " · no date on row"}
      </div>
    </div>
  );
}

type FactCardProps = { density?: undefined; model: FactCardModel } | { density: "matrix"; fact: MatrixFact };

/** The one fact card: a kind band, an optional figure lead, the claim with bold figures and embedded links, a four-line provenance column; or the operations matrix density. */
export function FactCard(props: FactCardProps) {
  const claimTiers = useContext(ClaimTierContext);
  if (props.density === "matrix") return <MatrixBody fact={props.fact} />;
  const model = claimTiers ? withClaimTiers(props.model, claimTiers) : props.model;
  const form = formFor(model.kind);
  const italic = form === "inference" ? " cl-fc-claim--inference" : "";
  return (
    <div className={`cl-fc cl-fc--${form}`} data-part="fact-card" data-kind={model.kind.toLowerCase().replace(/\s+/g, "-")} data-fact-card-kind={model.kind}>
      <div className="cl-fc-band">
        <p data-guard-title data-part-slot="kind-word" className="cl-fc-kind">
          {model.kind}
        </p>
        {model.qualifier && <p className="cl-fc-qualifier">{model.qualifier}</p>}
      </div>
      <div className={`cl-fc-body${model.figureLead ? " cl-fc-body--lead" : ""}`}>
        {model.figureLead && (
          <div className="cl-fc-lead">
            <p className="cl-fc-figure">{model.figureLead}</p>
            {model.figureSubLabel && <p className="cl-fc-sublabel">{model.figureSubLabel}</p>}
          </div>
        )}
        <div className="cl-fc-claim-col">
          <p className={`cl-fc-claim${italic}`}>
            <Claim nodes={model.claim} />
          </p>
          {model.additionalClaims?.map((c, i) => (
            <p key={i} className={`cl-fc-claim cl-fc-claim--more${italic}`}>
              <Claim nodes={c.claim} />
            </p>
          ))}
        </div>
        <div className="cl-fc-prov">
          <ProvenanceBlock provenance={model.provenance} inference={form === "inference"} />
          {model.additionalClaims?.map((c, i) => (
            <div key={i} className="cl-fc-prov-more">
              <ProvenanceBlock provenance={c.provenance} inference={form === "inference"} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
