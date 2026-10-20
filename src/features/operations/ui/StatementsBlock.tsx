// Ported from old_repo/src/components/operations/StatementsBlock.tsx (lines 29-195)
// The industry statements under the matrix: one sentence per (dimension, label) that two or more regions hold a sourced figure for, the components listed beneath so the sentence is checkable. It states what wages and
// costs are, sourced, and says nothing about what to do with them (ADR-043). A label the verdict screen refused is counted in the foot, not hidden. With no statements and none refused the block draws nothing.
import { ABSENCE_DASH, SectionCard, SectionHead, SourceLink, TierChip } from "@/ui";

import type { Statement, StatementComponent } from "../model/statements";

import styles from "./operations.module.css";

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <span>
    <span className={styles.metaLabel}>{label}</span>
    {children ?? "not stated"}
  </span>
);

function Component({ c }: { c: StatementComponent }) {
  return (
    <li data-audit="ops-statement-component" data-region={c.regionCode} className={styles.component}>
      <div className={styles.compLead}>
        <span data-part-slot="tier">{c.sourceTier !== null ? <TierChip tier={c.sourceTier} /> : <span aria-label="Source not rated" title="Source not rated">{ABSENCE_DASH}</span>}</span>
        <span className={styles.compRegion}>{c.regionLabel}</span>
        <span className={styles.compValue}>{c.valueText}</span>
        {c.index !== null && <span className={styles.thSub}>index {c.index}</span>}
      </div>
      <div className={styles.compMeta}>
        <Field label="Published by">{c.sourceName ? (c.sourceUrl ? <SourceLink href={c.sourceUrl}>{c.sourceName}</SourceLink> : c.sourceName) : null}</Field>
        <Field label="Dataset">{c.datasetRef}</Field>
        <Field label="Period">{c.referencePeriod}</Field>
        <Field label="Status flag">{[c.statusFlag, c.originClass].filter(Boolean).join(" · ") || null}</Field>
        <Field label="As at">{c.asAtDate}</Field>
      </div>
    </li>
  );
}

export function StatementsBlock({ statements, droppedVerdicts, dimensionNames = {} }: { statements: Statement[]; droppedVerdicts: number; dimensionNames?: Record<string, string> }) {
  if (statements.length === 0 && droppedVerdicts === 0) return null;
  return (
    <SectionCard as="section" dataAudit="ops-statements" aria-label="Statements">
      <SectionHead title="Statements" />
      <p className={styles.intro}>What the held figures say across regions. Components shown; nothing estimated.</p>
      <ol className={styles.statements}>
        {statements.map((s) => (
          <li key={`${s.dimension}|${s.factLabel}`} data-audit="ops-statement" data-dimension={s.dimension} className={styles.statement}>
            <p className={styles.kicker}>{dimensionNames[s.dimension] ?? s.dimension}</p>
            {s.sentence !== null ? (
              <p data-audit="ops-statement-sentence" className={styles.sentence}>{s.sentence}</p>
            ) : (
              <>
                <p data-audit="ops-statement-label" className={styles.sentence}><b>{s.factLabel}</b></p>
                <p data-audit="ops-statement-absence" className={styles.noteText}><span data-absence="needs" data-part="absence" className="cl-absence">{s.absence}</span></p>
              </>
            )}
            <ul className={styles.components}>
              {s.components.map((c) => (
                <Component key={c.regionCode} c={c} />
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {droppedVerdicts > 0 && (
        <p className={styles.intro}>
          {droppedVerdicts} {droppedVerdicts === 1 ? "figure is" : "figures are"} not stated here because {droppedVerdicts === 1 ? "its label reads" : "their labels read"} as advice; the facts remain in the matrix.
        </p>
      )}
    </SectionCard>
  );
}
