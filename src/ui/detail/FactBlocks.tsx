// Ported from old_repo/src/components/detail/FactBlocks.tsx (lines 1-56)
import type { ReactNode } from "react";

import { deriveFactCardModels, mergeAdjacentSameKind, parseFactParagraphs, type FactParagraph } from "@/core/detail/fact-model";

import { FactCard } from "../FactCard";
import { GfmSection } from "../GfmSection";
import { ItemGroup } from "../ItemGroup";

/** A section's markdown as fact groups and prose: each run of fact paragraphs is one ItemGroup of merged cards, a prose paragraph is markdown. `maxGroups` stops after that many groups. */
export function FactBlocks({ markdown, maxGroups }: { markdown: string | null | undefined; maxGroups?: number }) {
  const out: ReactNode[] = [];
  let run: FactParagraph[] = [];
  let groups = 0;
  const flush = () => {
    const models = mergeAdjacentSameKind(run.flatMap(deriveFactCardModels));
    run = [];
    if (models.length === 0 || (maxGroups && groups >= maxGroups)) return;
    groups += 1;
    out.push(<ItemGroup key={`g${groups}`}>{models.map((m, j) => <FactCard key={j} model={m} />)}</ItemGroup>);
  };
  parseFactParagraphs(markdown).forEach((b, i) => {
    if (b.kind !== "prose") return void run.push(b);
    flush();
    if (!maxGroups || groups < maxGroups) out.push(<GfmSection key={`p${i}`} markdown={b.text} />);
  });
  flush();
  return out.length > 0 ? <>{out}</> : null;
}
