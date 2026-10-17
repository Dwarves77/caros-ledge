"use client";

// Ported from old_repo/src/components/research/CredibilityChipAuthority.tsx (lines 30-147)
// Ported from old_repo/src/components/research/CredibilityChipEvidence.tsx (lines 20-84)
// Ported from old_repo/src/components/research/CredibilityChipShared.tsx (lines 30-138)
// Ported from old_repo/src/components/research/credibility-grade-modifiers.mjs (lines 1-43)
// The split credibility (two scores, never merged): evidence by agreement with its GRADE modifier ledger, and source authority as a distribution (never a mean). One file for the four the old tree had; it mounts per
// assessment with the stored evidence level and the stored distribution, and as the legend (no assessment) on the list. A line the data cannot fill names what it needs; no raw citation count is credibility.
import { useState } from "react";

import type { BiasTag } from "@/core/types";

import type { AssessmentView, AuthorityDistribution } from "../model/assessment-view";

import styles from "./research.module.css";

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const NEEDS = {
  indirectness: "needs the studies' mode, geography and cargo type",
  imprecision: "needs effect sizes with their intervals",
  inconsistency: "needs comparable estimates across studies",
  publicationBias: "needs shared awards and institutions across the evidence",
  upgrades: "needs effect size and independent replication",
} as const;

/** The six GRADE-style modifiers as visible line items. Only risk of bias has a data path (the source's bias tags); every other line says what it needs. */
export function gradeModifiers(biasTags: readonly BiasTag[] | undefined): Array<{ key: string; label: string; flagged: boolean; detail: string }> {
  const tags = biasTags ?? [];
  const bias = tags.map((b) => `${b.dimension}: ${b.tag}${b.confidence != null ? ` (confidence ${Math.round(b.confidence * 100)}%)` : ""}`).join("; ");
  return [
    { key: "risk_of_bias", label: "Risk of bias", flagged: tags.length > 0, detail: bias || "needs the source's funding, method and stakeholder tags" },
    { key: "indirectness", label: "Indirectness", flagged: false, detail: NEEDS.indirectness },
    { key: "imprecision", label: "Imprecision", flagged: false, detail: NEEDS.imprecision },
    { key: "inconsistency", label: "Inconsistency", flagged: false, detail: NEEDS.inconsistency },
    { key: "publication_bias", label: "Publication bias", flagged: false, detail: NEEDS.publicationBias },
    { key: "upgrades", label: "Upgrades (large effect size, convergent evidence)", flagged: false, detail: NEEDS.upgrades },
  ];
}
/** "2 high-authority · 1 medium · 1 vendor-flagged", with unknown standing and integrity flags only when above zero. */
export function authorityLabel(d: AuthorityDistribution): string {
  const parts = [`${d.highAuthorityIndependent ?? 0} high-authority`, `${d.medium ?? 0} medium`, `${d.vendorFlagged ?? 0} vendor-flagged`];
  if ((d.unknown ?? 0) > 0) parts.push(`${d.unknown} unknown standing`);
  if ((d.integrityFlagged ?? 0) > 0) parts.push(`${d.integrityFlagged} integrity-flagged`);
  return parts.join(" · ");
}
const AUTHORITY_PARTS = ["Role class (university, national lab, standards body, vendor)", "Institutional standing in this topic, not the brand", "Author standing in this topic", "Funding independence", "Reception by field-normalised citations, never raw counts", "Integrity (retraction, corrections, predatory venue)"];

function Chip({ open, onToggle, scored, children }: { open: boolean; onToggle: () => void; scored: boolean; children: string }) {
  return (
    <button type="button" aria-expanded={open} data-scored={scored} onClick={(e) => (e.preventDefault(), e.stopPropagation(), onToggle())} className={styles.chipBtn}>
      {children}
    </button>
  );
}

export function CredibilityChips({ assessment, biasTags }: { assessment?: AssessmentView | null; biasTags?: readonly BiasTag[] }) {
  const [open, setOpen] = useState<"evidence" | "authority" | null>(null);
  const evidence = assessment?.evidenceScore ?? null;
  const authority = assessment?.authority ?? null;
  const mods = gradeModifiers(biasTags);
  const flagged = mods.filter((m) => m.flagged).length;
  const toggle = (k: "evidence" | "authority") => setOpen((o) => (o === k ? null : k));
  return (
    <span className={styles.chips}>
      <Chip open={open === "evidence"} scored={evidence !== null} onToggle={() => toggle("evidence")}>
        {`Evidence × agreement: ${evidence ? `${cap(evidence)} × needs agreement data` : "needs evidence-synthesis data"}${flagged > 0 ? ` (${flagged})` : ""}`}
      </Chip>
      <Chip open={open === "authority"} scored={authority !== null} onToggle={() => toggle("authority")}>
        {`Source authority: ${authority ? authorityLabel(authority) : "needs role-class data"}`}
      </Chip>
      {open === "evidence" && (
        <div role="group" aria-label="Evidence × agreement detail" className={styles.chipPanel}>
          <p className={styles.fine}>GRADE modifier ledger. Each line is shown, never folded into the level.</p>
          <ul className={styles.list}>
            {mods.map((m) => (
              <li key={m.key}>
                <b>{m.label}</b>
                {m.flagged ? " (flagged)" : ""}: {m.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {open === "authority" && (
        <div role="group" aria-label="Source authority detail" className={styles.chipPanel}>
          <p className={styles.fine}>Authority is a distribution of the sources behind the assessment, never an average: an average would hide the one dissenting national lab.</p>
          <ul className={styles.list}>
            {AUTHORITY_PARTS.map((p) => (
              <li key={p}>{p}: needs the publisher&apos;s records</li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}
