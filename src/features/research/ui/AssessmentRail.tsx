// Ported from old_repo/src/components/research/ResearchFindingDetailSurface.tsx (lines 465-542)
// Ported from old_repo/src/components/research/DissentPanel.tsx (lines 31-124)
// Ported from old_repo/src/components/research/SignpostList.tsx (lines 30-76)
// Ported from old_repo/src/components/research/AssessmentHistoryLedger.tsx (lines 25-106)
// Ported from old_repo/src/components/research/RailAbsenceNote.tsx (lines 1-32)
// The Research rail, four cards over the stored assessment: the horizon assessment (corridors with their method, the horizon with its basis, or the stated refusal), the dissent panel (never collapsed: explicit dissent,
// else the authority mix, else the absence), the signposts (the watched entity by name) and the append-only history. Customer words only: a value the data cannot give names what it needs, and nothing here names a
// producer, a table or a specification.
import { formatDate } from "@/core/shared";
import { SectionCard, TagChip } from "@/ui";

import { HORIZON_BAND_WORDS, HORIZON_KIND_WORDS, predicateWords, refusalText, type AssessmentView, type HistoryEntry, type SignpostView } from "../model/assessment-view";
import type { AssessmentBundle } from "../read/research-reads";

import styles from "./research.module.css";

/** One short label per stance token (the token's own words; no sentence about the finding). */
const STANCE_LABEL: Readonly<Record<string, string>> = { act_today: "Act or invest today", wait_stage: "Wait and stage" };

/** The UI words for the horizon-rule token the stored assessment carries (the evidence state is the token; these are its labels). */
const RULE_LABEL: Readonly<Record<string, string>> = { R1: "a dated statutory instrument", R3: "a named institutional roadmap", R4: "inferred from maturity, no dated evidence" };
const Kv = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className={styles.kv}>
    <span className={styles.kvLabel}>{label}</span>
    <span className={styles.kvValue}>{children}</span>
  </div>
);
const themeOf = (t: string) => (t === "Dissent" ? "risk" : t === "Horizon assessment" ? "connected" : "sources");
const Card = ({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) => (
  <SectionCard dataAttributes={{ "data-part": "rail-card", "data-rail-theme": themeOf(title) }}>
    <div className="cl-rail-card">
      <div className={`cl-rail-head${aside ? " cl-rail-head--split" : ""}`}>
        <h2 data-guard-title className="cl-rail-title">{title}</h2>
        {aside}
      </div>
      <div className={styles.stack}>{children}</div>
    </div>
  </SectionCard>
);

/** The horizon assessment: TRL and CRI corridors with the method each was read by, the horizon with its kind, rule and confidence and the basis, or the stated refusal (a first-class state, spec 03 section 6). */
export function AssessmentCard({ assessment, failed }: { assessment: AssessmentView | null; failed: boolean }) {
  return (
    <Card title="Horizon assessment" aside={assessment ? <span title={assessment.anchored ? "Anchored to a dated instrument or roadmap" : "Inferred, not anchored to a dated source"} className={`${styles.badge}${assessment.anchored ? ` ${styles.badgeOn}` : ""}`}>{assessment.anchored ? "Dated source" : "Inferred"}</span> : null}>
      {failed ? (
        <p className={styles.note} role="alert" data-part="state-note">The assessment did not load. Reload the page to try again.</p>
      ) : !assessment ? (
        <p className={styles.note}>No horizon assessment yet. One needs a maturity phrase or a dated instrument in the finding&apos;s text.</p>
      ) : (
        <>
          <Kv label="Technical">{assessment.technical ? `${assessment.technical.label}${assessment.technical.method ? ` (${assessment.technical.method})` : ""}` : "no TRL corridor read from this finding's recorded text"}</Kv>
          <Kv label="Commercial">{assessment.commercial ? `${assessment.commercial.label}${assessment.commercial.method ? ` (${assessment.commercial.method})` : ""}` : "no CRI corridor read from this finding's recorded text"}</Kv>
          {assessment.horizon ? (
            <>
              <Kv label="Horizon">{`${HORIZON_BAND_WORDS[assessment.horizon.band] ?? assessment.horizon.band} · ${HORIZON_KIND_WORDS[assessment.horizon.kind]?.toLowerCase() ?? assessment.horizon.kind} · read from ${RULE_LABEL[assessment.horizon.rule] ?? assessment.horizon.rule}${assessment.horizon.confidence ? ` · ${assessment.horizon.confidence} confidence` : ""}`}</Kv>
              {assessment.horizon.triggerNote && <Kv label="Basis">{assessment.horizon.triggerNote}</Kv>}
              {assessment.forwardOutlook && <Kv label="Stance">{`${STANCE_LABEL[assessment.forwardOutlook.stance] ?? assessment.forwardOutlook.stance} · ${HORIZON_BAND_WORDS[assessment.forwardOutlook.horizon] ?? assessment.forwardOutlook.horizon}`}</Kv>}
            </>
          ) : (
            <Kv label="Horizon">{`Not forecastable: ${refusalText(assessment.refusalReason)}`}</Kv>
          )}
        </>
      )}
    </Card>
  );
}

/** Dissent is never collapsed. No explicit per-source dissent exists in the data, so the panel shows the authority mix of the sources behind the assessment (never averaged away), or says what it needs. */
export function DissentPanel({ assessment }: { assessment: AssessmentView | null }) {
  const d = assessment?.authority ?? null;
  const buckets = d ? ([["highAuthorityIndependent", "high-authority independent"], ["medium", "medium"], ["vendorFlagged", "vendor-flagged"], ["unknown", "unknown standing"]] as const).filter(([k]) => (d[k] ?? 0) > 0) : [];
  const total = d?.sources?.length ?? 0;
  return (
    <Card title="Dissent">
      {buckets.length > 1 ? (
        <>
          <p className={styles.note}>
            No per-source dissenting conclusion is recorded. The {total || "contributing"} source{total === 1 ? "" : "s"} behind this assessment differ in standing, shown here rather than averaged away:
          </p>
          <ul className={styles.list}>
            {buckets.map(([k, label]) => (
              <li key={k}>{d?.[k]} {label}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className={styles.note}>No dissent recorded for this finding. Dissent needs a second source of different standing, or a stated conclusion that differs.</p>
      )}
    </Card>
  );
}

/** The signposts: what each watches (by name), what it would show, and whether it has fired. */
export function SignpostList({ signposts }: { signposts: SignpostView[] }) {
  return (
    <Card title="Signposts">
      {signposts.length === 0 ? (
        <p className={styles.note}>No signposts yet. A signpost needs a dated instrument or roadmap to anchor the horizon.</p>
      ) : (
        <div className={styles.stack}>
          {signposts.map((s) => (
            <div key={s.entityId} className={styles.signpost}>
              <div className={styles.signpostBody}>
                <span className={styles.kvValue}>{s.watchesLabel ? `watches ${s.watchesLabel}, ${s.direction}` : `a watched record, ${s.direction}`}</span>
                <span className={styles.fine}>{predicateWords(s.predicate)}</span>
              </div>
              <span className={`${styles.badge}${s.firedAt ? ` ${styles.badgeOn}` : ""}`}>{s.firedAt ? `Fired ${formatDate(s.firedAt.slice(0, 10))}` : "Watching"}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const entryLine = (e: HistoryEntry): string => [e.technicalLabel, e.commercialLabel, e.horizonBand].filter(Boolean).join(" · ") || "no corridor or horizon read";

/** The append-only chain, newest first. A chain shorter than the real one says so: a card that silently rewrote its own history would be a marketing artefact. */
export function AssessmentHistory({ bundle }: { bundle: Pick<AssessmentBundle, "history" | "historyComplete"> }) {
  const { history, historyComplete } = bundle;
  return (
    <Card title="Assessment history">
      {history.length === 0 ? (
        <p className={styles.note}>No history yet. It starts with the first assessment of this finding.</p>
      ) : (
        <>
          <div className={styles.stack}>
            {history.map((e) => (
              <div key={e.id} className={styles.entry}>
                <div className={styles.entryHead}>
                  <span className={`${styles.entryState}${e.isCurrent ? ` ${styles.entryStateOn}` : ""}`}>{e.isCurrent ? "Current" : "Superseded"}</span>
                  <span className={styles.fine}>{formatDate(e.computedAt.slice(0, 10))}</span>
                  {e.lifecycleState && <TagChip>{e.lifecycleState}</TagChip>}
                </div>
                <span className={styles.kvValue}>{entryLine(e)}</span>
              </div>
            ))}
          </div>
          {history.length === 1 && historyComplete && <p className={styles.fine}>No earlier version: this is the first assessment of this finding.</p>}
          {!historyComplete && <p className={styles.fine}>Earlier versions of this assessment exist but are not shown to this session.</p>}
        </>
      )}
    </Card>
  );
}
