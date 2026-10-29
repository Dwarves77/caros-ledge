"use client";

// Ported from old_repo/src/components/sources/SourceHealthDashboard.tsx (lines 256-529)
import { useMemo, useState } from "react";

import { formatNumber } from "@/core/shared";
import { customerTierOf } from "@/core/sources/tier-contract";
import type { AdminProvisional, AdminSource } from "@/features/admin/read/sources";
import { EmptyState, FormField, Input, SectionCard, SectionHead, TabRow } from "@/ui";
import { UpcomingObligationsPanel } from "@/features/admin/ui/UpcomingObligationsPanel";
import styles from "@/features/admin/ui/admin.module.css";

import { CanonicalQueue } from "./CanonicalQueue";
import { ConnectionPairsView } from "./ConnectionPairsView";
import { ConnectionThemesView } from "./ConnectionThemesView";
import { ProvisionalQueue } from "./ProvisionalQueue";
import { RegenerationNote } from "./RegenerationNote";
import { ScrapeScheduleStrip } from "./ScrapeScheduleStrip";
import { SourceRow } from "./SourceRow";
import { TierDefinitionsOverlay, TierFacet, TierLegend, tierCounts } from "./TierLegend";

export type RegistryView = "registry" | "health" | "provisional" | "canonical" | "pairs" | "themes" | "obligations";
const VIEW_LABELS: Record<RegistryView, string> = { registry: "Source registry", health: "Health", provisional: "Provisional", canonical: "Canonical source issues", pairs: "Intersections", themes: "Themes", obligations: "Upcoming obligations" };

/** The registry filtered by tier (the tier a customer sees), status and a name, description and notes search; the facet counts and the filter use the one tier function. Pure. */
function filterRegistry(sources: readonly AdminSource[], f: { tiers: readonly number[]; search: string }): AdminSource[] {
  const q = f.search.toLowerCase();
  return sources.filter((s) => {
    const t = customerTierOf(s);
    if (f.tiers.length && (t === null || !f.tiers.includes(t))) return false;
    return !q || `${s.name} ${s.description} ${s.notes}`.toLowerCase().includes(q);
  });
}
/** Sources whose next scheduled check has passed, as of the request's one instant. Pure. */
const overdue = (sources: readonly AdminSource[], nowIso: string): AdminSource[] => sources.filter((s) => s.next_scheduled_check !== null && s.next_scheduled_check < nowIso);

/** The source registry card: the tier legend, the scrape schedule, and seven views (the registry, its health, the provisional queue, canonical source issues, connection pairs, themes, upcoming obligations). Every view that reads says so when the read fails. */
export function SourceRegistryCard({ sources, provisional, initialView, nowIso, pendingTotal, stagedCount, onOpenStaged, onSourceChanged, onProvisionalRemoved }: { sources: AdminSource[]; provisional: AdminProvisional[]; initialView: RegistryView; nowIso: string; pendingTotal: number | null; stagedCount: number | null; onOpenStaged: () => void; onSourceChanged: (id: string, patch: Partial<AdminSource>) => void; onProvisionalRemoved: (id: string) => void }) {
  const [view, setView] = useState<RegistryView>(initialView);
  const [tiers, setTiers] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [defs, setDefs] = useState(false);
  const late = useMemo(() => overdue(sources, nowIso), [sources, nowIso]);
  const counts = useMemo(() => tierCounts(sources), [sources]);
  const shown = useMemo(() => filterRegistry(view === "health" ? late : sources, { tiers, search }), [view, late, sources, tiers, search]);
  const badge: Partial<Record<RegistryView, number>> = { registry: sources.length, health: late.length, provisional: pendingTotal ?? provisional.length };
  return (
    <SectionCard as="section" aria-label="Source registry">
      <SectionHead title={`Sources · ${VIEW_LABELS[view]}`} aside={`${formatNumber(sources.length)} sources`} />
      <div className={styles.body}>
        <TierLegend onOpenDefinitions={() => setDefs(true)} />
        <ScrapeScheduleStrip />
        <TabRow ariaLabel="Source registry views" semantics="tablist" tabs={(Object.keys(VIEW_LABELS) as RegistryView[]).map((v) => ({ key: v, label: `${VIEW_LABELS[v]}${badge[v] ? ` · ${formatNumber(badge[v] as number)}` : ""}`, active: v === view, onClick: () => setView(v) }))} />
        <RegenerationNote onOpenQueue={onOpenStaged} />
        {view === "registry" || view === "health" ? (
          <>
            <TierFacet counts={counts} active={tiers} onToggle={(t) => setTiers(tiers.includes(t) ? tiers.filter((x) => x !== t) : [...tiers, t])} />
            <FormField label="Filter the registry by name">{(c) => <Input {...c} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter the registry by name" />}</FormField>
            {view === "health" ? <p className={styles.note}>{late.length === 0 ? "No source is overdue for a check." : `${formatNumber(late.length)} sources are overdue for a check.`}</p> : null}
            {shown.length === 0 ? <EmptyState>{sources.length === 0 ? "The registry holds no sources." : "No source matches these filters."}</EmptyState> : shown.map((s) => <SourceRow key={s.id} source={s} expanded={expanded === s.id} onToggle={() => setExpanded(expanded === s.id ? null : s.id)} onChanged={(p) => onSourceChanged(s.id, p)} />)}
          </>
        ) : null}
        {view === "provisional" ? <ProvisionalQueue rows={provisional} pendingTotal={pendingTotal} stagedCount={stagedCount} onOpenStaged={onOpenStaged} onRemoved={onProvisionalRemoved} /> : null}
        {view === "canonical" ? <CanonicalQueue /> : null}
        {view === "pairs" ? <ConnectionPairsView /> : null}
        {view === "themes" ? <ConnectionThemesView /> : null}
        {view === "obligations" ? <UpcomingObligationsPanel /> : null}
      </div>
      <TierDefinitionsOverlay open={defs} onClose={() => setDefs(false)} />
    </SectionCard>
  );
}
