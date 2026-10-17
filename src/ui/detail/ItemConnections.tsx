// Ported from old_repo/src/components/shell/ItemConnectionsCard.tsx (lines 1-46)
// Ported from old_repo/src/components/shell/RelevanceBadge.tsx (lines 1-46)
import Link from "next/link";

import type { ConnectionRow } from "@/core/flywheel/view-model";
import type { ItemRelevance } from "@/core/workspace";

import { TagChip } from "../Chips";
import { MoreBelowDisclosure } from "../ItemGroup";
import { RailCard } from "../SmallParts";
import { StateNote } from "../StateNote";

const SHOWN = 4;
const BAND_WORDS: Record<ItemRelevance["band"], string> = { high: "High relevance", medium: "Medium relevance", low: "Low relevance" };
const APPLIES_WORDS: Record<string, string> = { applies: "Applies to your organisation", does_not_apply: "Does not apply to your organisation", needs_profile_input: "Needs more of your profile to say" };

/** The connections strip of the masthead card: superseded-by, supersedes and the items this one is linked to, each a link on its own surface; the rest behind a closed disclosure. */
export function ItemConnections({ rows }: { rows: ConnectionRow[] }) {
  const linked = rows.filter((r) => r.href);
  if (linked.length === 0) return null;
  const item = (r: ConnectionRow) => (
    <Link key={`${r.id}-${r.label}`} href={r.href as string} prefetch={false} className="cl-detail-link" title={r.title}>
      <p className="cl-detail-label" style={{ margin: 0 }}>
        {r.label}
        {r.discovered ? " · discovered" : ""}
      </p>
      <p data-guard-title className="cl-detail-link-title">
        {r.title}
      </p>
    </Link>
  );
  return (
    <div data-part="item-connections">
      <p className="cl-detail-label">Connections</p>
      {linked.slice(0, SHOWN).map(item)}
      <MoreBelowDisclosure count={linked.length - SHOWN} itemNoun="more connections">
        {linked.slice(SHOWN).map(item)}
      </MoreBelowDisclosure>
    </div>
  );
}

export type RelevanceState = { phase: "loading" } | { phase: "failed"; retry: () => void } | { phase: "ready"; relevance: ItemRelevance | null };

/** The relevance rail card: the lens band, the one-line summary and the applicability gate in words. A failed read says so with Retry; no workspace profile is an honest "not available", never a band. */
export function RelevanceRailCard({ state }: { state: RelevanceState }) {
  return (
    <RailCard title="Relevance to you" dataAudit="relevance-rail">
      {state.phase === "loading" ? (
        <p className="cl-detail-link-note">Loading…</p>
      ) : state.phase === "failed" ? (
        <StateNote tone="error" action={{ label: "Retry", onClick: state.retry }}>
          Relevance did not load.
        </StateNote>
      ) : !state.relevance ? (
        <p className="cl-detail-link-note">Add your sectors, modes and jurisdictions in your profile to see how this reaches your operation.</p>
      ) : (
        <>
          <TagChip>{BAND_WORDS[state.relevance.band]}</TagChip>
          <p style={{ fontSize: "var(--fs-12)", color: "var(--ink-2)", margin: "8px 0 0" }}>{state.relevance.summary}</p>
          {state.relevance.applicability && <p className="cl-detail-link-note">{APPLIES_WORDS[state.relevance.applicability.status] ?? ""}</p>}
        </>
      )}
    </RailCard>
  );
}
