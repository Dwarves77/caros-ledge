"use client";

// Ported from old_repo/src/components/sources/CanonicalSourceReview.tsx (lines 94-607)
import { useState } from "react";

import { formatNumber } from "@/core/shared";
import { Button, Dialog, EmptyState, FilterChip, FilterChipGroup, SectionCard, SectionHead, StatBlock, StateNote } from "@/ui";
import { Load, useAct, useAdminFetch, useFlash } from "@/features/admin/ui/panel-kit";
import styles from "@/features/admin/ui/admin.module.css";

import { SourceClassificationEditor, type ClassificationDraft, type Decision } from "./SourceClassificationEditor";

interface Classification {
  tier: number | null;
  domains: number[];
  jurisdictions: string[];
  transport_modes: string[];
  topic_tags: string[];
}
interface Candidate {
  id: string;
  candidate_url: string;
  candidate_title: string | null;
  candidate_publisher: string | null;
  rationale: string | null;
  confidence: "high" | "medium" | "low";
  verified: boolean;
  existing_source_id: string | null;
  classification: Classification;
}
interface Group {
  item_id: string;
  item: { title: string | null } | null;
  issue_classification: string;
  candidates: Candidate[];
}
interface Payload {
  groups: Group[];
  stats: { total: number; items: number; by_confidence: Record<string, number>; by_issue: Record<string, number>; high_conf_verified: number; high_conf_unverified: number };
  page: { hasMore: boolean };
}
const ISSUES: Record<string, string> = { stale_url: "Stale address", missing_link: "Missing link", missing_source: "Missing source", thin_match: "Thin match" };

/** The candidates a bulk approve would act on: high confidence and verified, with a host the class table can place or a source already in the registry. Pure. */
export const bulkEligible = (groups: readonly Group[]): Candidate[] => groups.flatMap((g) => g.candidates).filter((c) => c.confidence === "high" && c.verified && (c.classification.tier !== null || c.existing_source_id !== null));

/** The canonical source issues: items whose source is stale or missing, with candidate replacements. An override surface (the gates already ruled where they could); a candidate is approved at the class table's tier, edited first, or rejected. Bulk approve says what it will do and what it will leave for individual review. */
export function CanonicalQueue() {
  const [conf, setConf] = useState<string | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const q = useAdminFetch<Payload>("/api/admin/canonical-sources/pending");
  const flash = useFlash();
  const act = useAct(flash, q.reload);
  const [summary, setSummary] = useState<string | null>(null);
  const decide = async (c: Candidate, decision: Decision, d: ClassificationDraft) => {
    const r = await act.run(c.id, "/api/admin/canonical-sources/decide", { method: "POST", body: { candidateId: c.id, decision, reviewerNotes: d.reviewerNotes || null, ...(decision === "approve" ? { assignedTier: d.assignedTier, domains: d.domains, jurisdictions: d.jurisdictions, transport_modes: d.transport_modes, topic_tags: d.topic_tags, existingSourceId: c.existing_source_id } : {}) } }, decision === "approve" ? "Candidate approved." : decision === "reject" ? "Rejected." : "Deferred.");
    if (r.ok) setOpen(null);
  };
  return (
    <div className={styles.stack}>
      <Load q={q} what="Canonical source issues">
        {(d) => {
          const eligible = bulkEligible(d.groups);
          const groups = d.groups.map((g) => ({ ...g, candidates: g.candidates.filter((c) => (!conf || c.confidence === conf) && (!issue || g.issue_classification === issue)) })).filter((g) => g.candidates.length > 0);
          return (
            <>
              <div className={styles.grid3}>
                <StatBlock label="Pending" value={formatNumber(d.stats.total)} />
                <StatBlock label="Items affected" value={formatNumber(d.stats.items)} />
                <StatBlock label="High and verified" value={formatNumber(d.stats.high_conf_verified)} />
              </div>
              <FilterChipGroup label="Confidence">{["high", "medium", "low"].map((c) => <FilterChip key={c} active={conf === c} onClick={() => setConf(conf === c ? null : c)}>{c} {formatNumber(d.stats.by_confidence[c] ?? 0)}</FilterChip>)}</FilterChipGroup>
              <FilterChipGroup label="Issue">{Object.keys(ISSUES).map((k) => <FilterChip key={k} active={issue === k} onClick={() => setIssue(issue === k ? null : k)}>{ISSUES[k]} {formatNumber(d.stats.by_issue[k] ?? 0)}</FilterChip>)}</FilterChipGroup>
              {eligible.length ? <StateNote action={{ label: `Approve ${eligible.length}`, onClick: () => setBulk(true) }}>{eligible.length} high-confidence, verified candidates can be approved together at their class tier.</StateNote> : null}
              {summary ? <StateNote>{summary}</StateNote> : null}
              {groups.length === 0 ? <EmptyState>No candidate source needs a ruling. The machine gates decide the rest; this queue is the override.</EmptyState> : null}
              {groups.map((g) => (
                <SectionCard key={g.item_id} as="section" aria-label={g.item?.title ?? "Item"}>
                  <SectionHead title={g.item?.title ?? "An item that could not be read"} aside={ISSUES[g.issue_classification] ?? g.issue_classification} />
                  <div className={styles.body}>
                    {g.candidates.map((c) => (
                      <div key={c.id} className={styles.rowMain}>
                        <b className={`${styles.strong} ${styles.wrap}`}>{c.candidate_publisher || c.candidate_title || c.candidate_url}</b>
                        <a href={c.candidate_url} target="_blank" rel="noopener noreferrer" className={`${styles.link} ${styles.wrap}`}>{c.candidate_url}</a>
                        <span className={styles.actions}><span className={styles.pill}>{c.confidence} confidence</span><span className={c.verified ? styles.pillOk : styles.pill}>{c.verified ? "address verified" : "address not verified"}</span>{c.existing_source_id ? <span className={styles.pill}>already in the registry</span> : null}</span>
                        {c.rationale ? <span className={styles.note}>{c.rationale}</span> : null}
                        <div className={styles.actions}><Button variant="secondary" size="sm" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? "Close" : "Review"}</Button></div>
                        {open === c.id ? <SourceClassificationEditor seed={{ name: c.candidate_publisher || c.candidate_title || c.candidate_url, url: c.candidate_url, tier: c.classification.tier, domains: c.classification.domains, jurisdictions: c.classification.jurisdictions, transport_modes: c.classification.transport_modes, topic_tags: c.classification.topic_tags }} busy={act.busy === c.id} onDecide={(decision, draft) => decide(c, decision, draft)} /> : null}
                      </div>
                    ))}
                  </div>
                </SectionCard>
              ))}
              {d.page.hasMore ? <p className={styles.muted}>More candidates are waiting beyond this page. Decide these and refresh.</p> : null}
              <Dialog open={bulk} onClose={() => setBulk(false)} title="Approve candidates together">
                <div className={styles.stack}>
                  <p className={styles.note}>This approves {eligible.length} candidates, each at the tier the class table gives its host, and links each item to its source. A candidate that needs a person (an unplaced host, a gated host) is left for individual review and the rest go ahead. Each decision is recorded with your name.</p>
                  <div className={styles.actions}>
                    <Button variant="secondary" onClick={() => setBulk(false)}>Cancel</Button>
                    <Button variant="primary" disabled={act.busy === "bulk"} onClick={async () => {
                      const r = await act.run("bulk", "/api/admin/canonical-sources/bulk-approve", { method: "POST", body: { candidateIds: eligible.map((c) => c.id).slice(0, 300) } }, "Bulk approve finished.");
                      setBulk(false);
                      const x = r.data as { approved?: number; created_sources?: number; failed?: number; requires_individual_review?: number } | null;
                      if (r.ok) setSummary(`Approved ${x?.approved ?? 0} (${x?.created_sources ?? 0} new sources), ${x?.failed ?? 0} failed, ${x?.requires_individual_review ?? 0} left for individual review.`);
                    }}>{act.busy === "bulk" ? "Approving..." : `Approve ${eligible.length}`}</Button>
                  </div>
                </div>
              </Dialog>
            </>
          );
        }}
      </Load>
      {flash.node}
    </div>
  );
}
