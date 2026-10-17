// Ported from old_repo/src/components/operations/LabourChain.tsx (lines 42-175)
// The fully-loaded labour rate, drawn: every term in order with its running subtotal, then the final rate or the named gap. Render-only: the chain arithmetic is ../model/labour-chain, which returns a cause per gap,
// so a term missing because only an annual figure is held says so (the old chain said "not in primary source" whatever the cause). The rate is drawn only when every term and a positive divisor exist, in one currency.
import { Absence, SectionHead } from "@/ui";

import { computeLabourChain, extractLabourChainTerms, type ChainTermResult, type LabourFactLike } from "../model/labour-chain";

import styles from "./operations.module.css";

const roundDisplay = (n: number): string => n.toFixed(Math.abs(n) < 10 ? 3 : 2);

function TermRow({ term }: { term: ChainTermResult }) {
  const operator = term.key === "baseWage" ? "" : term.key === "productiveHours" ? "÷" : "+";
  return (
    <div data-audit="labour-chain-term" data-chain-term={term.key} className={styles.term}>
      <span className={styles.termLead}>
        {operator && <span aria-hidden="true" className={styles.op}>{operator}</span>}
        <span className={styles.termName}>{term.label}</span>
      </span>
      {term.present && term.value ? (
        <span className={styles.termValue}>
          <span className={styles.termFigure}>{roundDisplay(term.value.valueNumeric)}</span> <span className={styles.termUnit}>{term.value.unit ?? ""}</span>
          <div className={styles.termCause}>
            {term.value.sourceKey ?? "unnamed source"}
            {term.value.referencePeriod ? ` · ${term.value.referencePeriod}` : ""}
          </div>
        </span>
      ) : (
        <span className={styles.termValue}>
          <Absence reason="not in primary source" />
          <div className={styles.termCause}>{term.cause}</div>
        </span>
      )}
    </div>
  );
}

export function LabourChain({ facts, regionLabel }: { facts: readonly LabourFactLike[]; regionLabel: string }) {
  const { input, causes } = extractLabourChainTerms(facts);
  const result = computeLabourChain(input, causes);
  return (
    <div data-audit="labour-chain" className={styles.chain}>
      <SectionHead title="Fully-loaded labour rate" aside={`${regionLabel} · ${result.suppressed ? "chain incomplete" : "chain complete"}`} />
      {result.terms.map((t) => (
        <TermRow key={t.key} term={t} />
      ))}
      <div data-audit="labour-chain-final" className={styles.final}>
        <b>= Fully-loaded rate</b>
        {result.suppressed ? (
          <span className={styles.termValue}>
            <Absence reason="not in primary source" />
            <div className={styles.termCause}>{result.gapReason}</div>
          </span>
        ) : (
          <span className={styles.finalFigure}>
            {roundDisplay(result.finalValue as number)} <span className={styles.termUnit}>{result.finalUnit}</span>
          </span>
        )}
      </div>
    </div>
  );
}
