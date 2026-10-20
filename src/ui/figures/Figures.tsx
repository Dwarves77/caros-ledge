// Ported from old_repo/src/components/figures/EstimatedFigure.tsx (lines 29-158)
// Ported from old_repo/src/components/figures/StatutoryFigure.tsx (lines 20-100)
// The three figure kinds as separate components with separate badges (INV-261, spec 08 section 4 layer 4): a modelled number can never be mistaken for a statutory one. Every one passes the ONE gate (admissibleFor) before a number is
// shown, and a refused figure shows its refusal, never a stale number relabelled. `now` is required: the render instant belongs to the request, never to the component. Each can carry the rating of the source it cites (INV-262).
import type { ReactNode } from "react";

import { formatNumber } from "@/core/shared";
import { admissibleFor } from "@/core/propagation/admissible";
import type { Use, Value, Verdict } from "@/core/propagation/types";

import { SectionCard } from "../SectionCard";

import styles from "./figures.module.css";

interface Common {
  figure: Value;
  label: string;
  /** The injected render instant. */
  now: Date;
  use?: Use | undefined;
  /** The rating of the figure's source, already formatted ("T2 · Intergovernmental"); null draws "Unrated", undefined draws no line. */
  rating?: string | null | undefined;
}

function Card({ kind, badge, badgeClass, label, figure, verdict, use, rating, children, foot }: { kind: string; badge: string; badgeClass?: string | undefined; label: string; figure: Value; verdict: Verdict; use: Use; rating?: string | null | undefined; children?: ReactNode; foot?: ReactNode }) {
  return (
    <SectionCard padding="14px 16px" dataAttributes={{ "data-figure-kind": kind, "data-method-id": figure.methodId, "data-method-version": figure.methodVersion }}>
      <div className={styles.head}>
        <span className={`${styles.badge} ${badgeClass ?? ""}`}>{badge}</span>
        <span className={styles.title}>{label}</span>
      </div>
      {verdict.ok ? (
        children
      ) : (
        <p role="status" className={styles.refused}>
          Not admissible for {use}: {verdict.reason}.
        </p>
      )}
      {foot}
      {verdict.ok && (
        <p className={styles.meta}>
          Confidence {formatNumber(Math.round(verdict.effectiveConfidence * 100))}% · origin: {verdict.mustLabel} · lifecycle: {figure.lifecycle}
          {rating !== undefined && ` · source rating: ${rating ?? "Unrated"}`}
        </p>
      )}
    </SectionCard>
  );
}

/** A plain derived value, neither statutory nor estimated (a deterministic conversion of a published factor): one number, never a range. */
export function DerivedFigure({ figure, label, now, use = "calculation", rating, sourceNote }: Common & { sourceNote?: string | null }) {
  const verdict = admissibleFor(figure, use, now);
  return (
    <Card kind="derived" badge="Derived" label={label} figure={figure} verdict={verdict} use={use} rating={rating} foot={sourceNote ? <p className={styles.meta}>{sourceNote}</p> : null}>
      <p className={styles.stat}>
        {figure.value === null || !Number.isFinite(figure.value) ? "—" : formatNumber(figure.value, { maximumFractionDigits: 1 })}
        {figure.unit ? <span className={styles.unit}>{figure.unit}</span> : null}
      </p>
    </Card>
  );
}
