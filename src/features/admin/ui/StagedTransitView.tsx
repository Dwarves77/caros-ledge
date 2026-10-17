"use client";

// Ported from old_repo/src/components/admin/AdminDashboard.tsx (lines 728-806)
// Ported from old_repo/src/components/admin/ProvenanceFailures.tsx (lines 24-183)
import { formatLocaleDateTime } from "@/core/shared";
import { EmptyState, SectionCard, SectionHead } from "@/ui";

import type { StagedRow } from "../read/dashboard";

import styles from "./admin.module.css";

export interface Failure {
  criterion: number;
  reason: string;
  url?: string;
  claim?: string;
  source_tier_at_grounding?: number | null;
  priority?: string;
  slot_key?: string;
  item_type?: string;
  section_row_id?: string;
  [k: string]: unknown;
}
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const spanReason: Record<string, string> = { fact_missing_source_span: "no source span", fact_span_not_in_source: "span not found in cited source" };

interface Mode {
  key: string;
  label: string;
  match: (f: Failure) => boolean;
  describe: (f: Failure) => string;
}
/** The five reviewer-facing modes of a provenance-gate failure (validate_item_provenance criteria 2 to 5). */
export const MODES: readonly Mode[] = [
  { key: "ungrounded_url", label: "Ungrounded URLs", match: (f) => f.criterion === 2 && f.reason === "ungrounded_url", describe: (f) => f.url || "(address missing)" },
  { key: "unverified_span", label: "Unverified FACT spans", match: (f) => f.criterion === 3, describe: (f) => `${f.claim ? `"${cut(f.claim, 90)}": ` : ""}${f.reason === "fact_below_authority_floor" ? `below the tier floor (tier ${f.source_tier_at_grounding ?? "unrated"}, ${f.priority ?? "no priority"})` : (spanReason[f.reason] ?? f.reason)}` },
  { key: "unlabeled", label: "Unlabeled or mislabeled analysis", match: (f) => f.criterion === 4 && (f.reason === "analysis_missing_label_syntax" || f.reason === "unlabeled_assertion"), describe: (f) => (f.reason === "unlabeled_assertion" ? `unlabeled strong-modal assertion${f.section_row_id ? ` (section ${f.section_row_id.slice(0, 8)})` : ""}` : `analysis without a closed-set label${f.claim ? `: "${cut(f.claim, 90)}"` : ""}`) },
  { key: "missing_slot", label: "Missing required slots", match: (f) => f.criterion === 5 && f.reason === "missing_required_slot", describe: (f) => `${f.slot_key ?? "(slot)"}${f.item_type ? ` · ${f.item_type}` : ""}` },
  { key: "legal", label: "Legal conclusions not routed", match: (f) => f.criterion === 4 && f.reason === "legal_not_routed_to_callout", describe: (f) => (f.claim ? `"${cut(f.claim, 110)}"` : "a legal claim without the Legal Confirmation Required callout") },
];

/** The failures array of a staged row, wherever the writer stamped it (top level or under either envelope). Pure. */
export function extractFailures(update: unknown): Failure[] {
  const u = update as { provenance_failures?: unknown; proposed_data?: { provenance_failures?: unknown } | null; proposed_changes?: { provenance_failures?: unknown } | null } | null;
  const raw = u?.provenance_failures ?? u?.proposed_data?.provenance_failures ?? u?.proposed_changes?.provenance_failures ?? null;
  return Array.isArray(raw) ? (raw as Failure[]) : [];
}

/** Failures grouped into the five modes; one that matches none is kept under "Other", never dropped. Pure. */
export function groupFailures(failures: readonly Failure[]) {
  const groups = MODES.map((m) => ({ key: m.key, label: m.label, lines: failures.filter(m.match).map((f) => ({ text: m.describe(f), href: m.key === "ungrounded_url" && f.url ? f.url : null })) })).filter((g) => g.lines.length > 0);
  const matched = new Set(MODES.flatMap((m) => failures.filter(m.match)));
  const other = failures.filter((f) => !matched.has(f));
  return other.length ? [...groups, { key: "other", label: "Other", lines: other.map((f) => ({ text: `criterion ${f.criterion} · ${f.reason}`, href: null })) }] : groups;
}

function Failures({ failures }: { failures: Failure[] }) {
  if (!failures.length) return null;
  return (
    <div className={styles.detail}>
      <span className={styles.pillBad}>Provenance gate · {failures.length} failure{failures.length === 1 ? "" : "s"}</span>
      {groupFailures(failures).map((g) => (
        <div key={g.key}>
          <p className={styles.strong}>{g.label} <span className={styles.muted}>· {g.lines.length}</span></p>
          <ul className={styles.stack}>
            {g.lines.map((l, i) => (
              <li key={i} className={styles.note}>{l.href ? <a href={l.href} target="_blank" rel="noopener noreferrer" className={styles.wrap}>{l.text}</a> : <span className={styles.wrap}>{l.text}</span>}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * Staged updates are transit only: the machine gates are the approval and a staged row resolves by the intake cycle (materialized, rejected with its reason, or routed to a flag). This view shows them, and the
 * provenance failures that held them; there is nothing here to approve or reject.
 */
export function StagedTransitView({ rows, total }: { rows: StagedRow[]; total: number }) {
  return (
    <SectionCard as="section" aria-label="Staged updates">
      <SectionHead title="Staged updates" aside={`${total} staged`} />
      <div className={styles.body}>
        {rows.length === 0 ? (
          <EmptyState>Nothing is staged. Changes the machine detects pass through here on their way through the gates.</EmptyState>
        ) : (
          rows.map((u) => {
            const pc = (u.proposed_changes ?? {}) as { title?: string; summary?: string };
            return (
              <div key={u.id} className={styles.detail}>
                <div className={styles.actions}>
                  <span className={styles.pill}>{u.update_type}</span>
                  <span className={styles.muted}>{formatLocaleDateTime(new Date(u.created_at))}</span>
                </div>
                {pc.title ? <p className={styles.strong}>{pc.title}</p> : <p className={styles.note}>{u.reason || "No reason recorded."}</p>}
                {pc.summary ? <p className={styles.note}>{pc.summary}</p> : null}
                <Failures failures={extractFailures(u)} />
                <p className={styles.muted}>Machine-gated: it resolves through the intake cycle.</p>
              </div>
            );
          })
        )}
        {total > rows.length ? <p className={styles.muted}>Showing the newest {rows.length} of {total}.</p> : null}
      </div>
    </SectionCard>
  );
}
