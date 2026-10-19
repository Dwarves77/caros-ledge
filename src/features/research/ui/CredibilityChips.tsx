"use client";

// Ported from old_repo/src/components/research/CredibilityChipAuthority.tsx (lines 30-147)
// Ported from old_repo/src/components/research/CredibilityChipEvidence.tsx (lines 20-84)
// Ported from old_repo/src/components/research/CredibilityChipShared.tsx (lines 30-138)
// Ported from old_repo/src/components/research/credibility-grade-modifiers.mjs (lines 1-43)
// The split credibility (two scores, never merged): evidence by agreement with its GRADE modifier ledger, and source authority as a distribution (never a mean). One file for the four the old tree had; it mounts per
// assessment with the stored evidence level and the stored distribution, and as the legend (no assessment) on the list. A line the data cannot fill is not drawn; no raw citation count is credibility.
import { useState } from "react";

import type { BiasTag } from "@/core/types";

import type { AssessmentView, AuthorityDistribution } from "../model/assessment-view";

import styles from "./research.module.css";

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const OTHER_MODIFIERS = "Indirectness, imprecision, inconsistency, publication bias and upgrades are not recorded for this finding.";

/** The GRADE-style modifier lines that have data. Only risk of bias has a data path (the source's bias tags); a modifier with no data is not drawn as a line. */
export function gradeModifiers(biasTags: readonly BiasTag[] | undefined): Array<{ key: string; label: string; detail: string }> {
  const tags = biasTags ?? [];
  if (tags.length === 0) return [];
  return [{ key: "risk_of_bias", label: "Risk of bias", detail: tags.map((b) => `${b.dimension}: ${b.tag}${b.confidence != null ? ` (confidence ${Math.round(b.confidence * 100)}%)` : ""}`).join("; ") }];
}
/** "2 high-authority · 1 medium · 1 vendor-flagged", with unknown standing and integrity flags only when above zero. */
export function authorityLabel(d: AuthorityDistribution): string {
  const parts = [`${d.highAuthorityIndependent ?? 0} high-authority`, `${d.medium ?? 0} medium`, `${d.vendorFlagged ?? 0} vendor-flagged`];
  if ((d.unknown ?? 0) > 0) parts.push(`${d.unknown} unknown standing`);
  if ((d.integrityFlagged ?? 0) > 0) parts.push(`${d.integrityFlagged} integrity-flagged`);
  return parts.join(" · ");
}

function Chip({ open, onToggle, scored, children }: { open: boolean; onToggle: () => void; scored: boolean; children: string }) {
  return (
    <button type="button" aria-expanded={open} data-scored={scored} onClick={(e) => (e.preventDefault(), e.stopPropagation(), onToggle())} className={styles.chipBtn}>
      {children}
    </button>
  );
}

/**
 * On a finding with an assessment, each chip appears when its score is recorded and is absent when it is not (no placeholder line, no "needs" sentence). With no assessment (the list's legend) the two chips
 * name the two scores and open to what each one means.
 */
export function CredibilityChips({ assessment, biasTags }: { assessment?: AssessmentView | null; biasTags?: readonly BiasTag[] }) {
  const [open, setOpen] = useState<"evidence" | "authority" | null>(null);
  const legend = !assessment;
  const evidence = assessment?.evidenceScore ?? null;
  const authority = assessment?.authority ?? null;
  const mods = gradeModifiers(biasTags);
  const toggle = (k: "evidence" | "authority") => setOpen((o) => (o === k ? null : k));
  return (
    <span className={styles.chips}>
      {(legend || evidence) && (
        <Chip open={open === "evidence"} scored={evidence !== null} onToggle={() => toggle("evidence")}>
          {`Evidence × agreement${evidence ? `: ${cap(evidence)}${mods.length > 0 ? ` (${mods.length})` : ""}` : ""}`}
        </Chip>
      )}
      {(legend || authority) && (
        <Chip open={open === "authority"} scored={authority !== null} onToggle={() => toggle("authority")}>
          {`Source authority${authority ? `: ${authorityLabel(authority)}` : ""}`}
        </Chip>
      )}
      {open === "evidence" && (
        <div role="group" aria-label="Evidence × agreement detail" className={styles.chipPanel}>
          <p className={styles.fine}>{legend ? "The quality of the evidence behind a finding, read through GRADE modifiers and kept apart from who is asserting it." : "GRADE modifier ledger. Each line is shown, never folded into the level."}</p>
          {!legend && (
            <ul className={styles.list}>
              {mods.map((m) => (
                <li key={m.key}>
                  <b>{m.label}</b> (flagged): {m.detail}
                </li>
              ))}
              <li>{OTHER_MODIFIERS}</li>
            </ul>
          )}
        </div>
      )}
      {open === "authority" && (
        <div role="group" aria-label="Source authority detail" className={styles.chipPanel}>
          <p className={styles.fine}>Authority is a distribution of the sources behind the assessment, never an average: an average would hide the one dissenting national lab.</p>
        </div>
      )}
    </span>
  );
}
