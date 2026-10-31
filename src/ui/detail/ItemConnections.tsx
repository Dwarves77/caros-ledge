// Ported from old_repo/src/components/shell/ItemConnectionsCard.tsx (lines 1-46)
// Ported from old_repo/src/components/shell/RelevanceBadge.tsx (lines 1-46)
import Link from "next/link";

import { normalizeDisplayTitle } from "@/core/fetch/titles";
import { displayTitle as shortTitle } from "@/core/lists/display-title";
import type { ConnectionRow } from "@/core/flywheel/view-model";
import type { ItemRelevance } from "@/core/workspace";

import { TagChip } from "../Chips";
import { MoreBelowDisclosure } from "../ItemGroup";
import { RailCard } from "../SmallParts";
import { StateNote } from "../StateNote";

const SHOWN = 4;
const BAND_WORDS: Record<ItemRelevance["band"], string> = { high: "High relevance", medium: "Medium relevance", low: "Low relevance" };
const APPLIES_WORDS: Record<string, string> = { applies: "Applies to your organisation", does_not_apply: "Does not apply to your organisation", needs_profile_input: "Needs more of your profile to say" };

/** The connections strip of the masthead card: superseded-by, supersedes and the items this one is linked to, each a link on its own surface with the sentence that says why; the rest behind a closed disclosure. Chains that are still forming follow under "Developing". */
export function ItemConnections({ rows }: { rows: ConnectionRow[] }) {
  const linked = rows.filter((r) => r.href && !r.developing);
  const forming = rows.filter((r) => r.href && r.developing);
  if (linked.length === 0 && forming.length === 0) return null;
  const item = (r: ConnectionRow) => {
    const { title: displayTitle, subtitle } = normalizeDisplayTitle(shortTitle(r.title, true));
    return (
      <Link key={`${r.id}-${r.label}`} href={r.href as string} prefetch={false} className="cl-detail-link" title={r.title} data-discovered={r.discovered ? "true" : undefined}>
        <p className="cl-detail-label" style={{ margin: 0 }}>
          {r.developing?.family ?? r.label}
          {r.surface && r.surface !== "uncategorized" ? ` · ${r.surface}` : ""}
        </p>
        <p data-guard-title className="cl-detail-link-title">
          {displayTitle}
        </p>
        {subtitle && <p className="cl-detail-link-note">{subtitle}</p>}
        <p className="cl-detail-link-context">{r.reason}</p>
        {r.developing?.next && <p className="cl-detail-link-context">Next link to watch: {r.developing.next}</p>}
      </Link>
    );
  };
  return (
    <div data-part="item-connections">
      {linked.length > 0 && (
        <>
          <p className="cl-detail-label">Connections</p>
          <div className="cl-conn-grid">{linked.slice(0, SHOWN).map(item)}</div>
          <MoreBelowDisclosure count={linked.length - SHOWN} itemNoun="more connections">
            <div className="cl-conn-grid">{linked.slice(SHOWN).map(item)}</div>
          </MoreBelowDisclosure>
        </>
      )}
      <p className="cl-detail-label">Developing</p>
      {forming.length > 0 ? <div className="cl-conn-grid">{forming.slice(0, SHOWN).map(item)}</div> : <p className="cl-detail-link-note">No connection is forming for this item yet. One appears here when two items share a link that still lacks one fact.</p>}
    </div>
  );
}

export type RelevanceState = { phase: "loading" } | { phase: "failed"; retry: () => void } | { phase: "ready"; relevance: ItemRelevance | null };

/** The relevance rail card: the lens band, the one-line summary and the applicability gate in words. A failed read says so with Retry; no workspace profile is an honest "not available", never a band. */
export function RelevanceRailCard({ state }: { state: RelevanceState }) {
  const triggers = state.phase === "ready" && state.relevance ? [...new Set((state.relevance.binding?.lines ?? []).flatMap((l) => l.triggers.map((t) => t.label)))] : [];
  const reasons = state.phase === "ready" && state.relevance?.applicability?.reasons?.length ? state.relevance.applicability.reasons : [];
  return (
    <RailCard title="Relevance to you" dataAudit="relevance-rail">
      {state.phase === "loading" ? <p className="cl-detail-link-note">Loading…</p> : state.phase === "failed" ? (
        <StateNote tone="error" action={{ label: "Retry", onClick: state.retry }}>Relevance did not load.</StateNote>
      ) : !state.relevance ? (
        <p className="cl-detail-link-note">Add your sectors, modes and jurisdictions in your profile to see how this reaches your operation.</p>
      ) : (
        <>
          <TagChip>{BAND_WORDS[state.relevance.band]}</TagChip>
          <p style={{ fontSize: "var(--fs-12)", color: "var(--ink-2)", margin: "var(--sp-8) 0 0" }}>{state.relevance.summary}</p>
          {state.relevance.applicability && <p className="cl-detail-link-note">{APPLIES_WORDS[state.relevance.applicability.status] ?? ""}</p>}
          {triggers.length > 0 && <p className="cl-detail-link-note">In scope because: {triggers.join("; ")}</p>}
          {reasons.length > 0 && <p className="cl-detail-link-note">{reasons.join(" ")}</p>}
        </>
      )}
    </RailCard>
  );
}
