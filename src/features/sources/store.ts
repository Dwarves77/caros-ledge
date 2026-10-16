"use client";

// Ported from old_repo/src/stores/sourceStore.ts (lines 1-119)
import { create } from "zustand";

import { customerTierOf } from "@/core/sources/tier-contract";
import type { IntelligenceDomain, ProvisionalSource, Source, SourceTier } from "@/core/sources/types";

export interface SourceFilters {
  tiers: SourceTier[];
  statuses: string[];
  domains: number[];
  jurisdictions: string[];
  search: string;
}
export type SourceView = "registry" | "health" | "provisional" | "canonical" | "intersections" | "themes" | "obligations";

interface SourceState {
  sources: Source[];
  provisionalSources: ProvisionalSource[];
  filters: SourceFilters;
  expandedSourceId: string | null;
  activeView: SourceView;
  setSources: (sources: Source[]) => void;
  setProvisionalSources: (ps: ProvisionalSource[]) => void;
  toggleTierFilter: (tier: SourceTier) => void;
  toggleStatusFilter: (status: string) => void;
  toggleDomainFilter: (domain: number) => void;
  setSourceSearch: (search: string) => void;
  clearSourceFilters: () => void;
  setExpandedSource: (id: string | null) => void;
  setActiveView: (view: SourceView) => void;
}
const emptyFilters = (): SourceFilters => ({ tiers: [], statuses: [], domains: [], jurisdictions: [], search: "" });
const toggled = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export const useSourceStore = create<SourceState>((set) => ({
  sources: [],
  provisionalSources: [],
  filters: emptyFilters(),
  expandedSourceId: null,
  activeView: "registry",
  setSources: (sources) => set({ sources }),
  setProvisionalSources: (provisionalSources) => set({ provisionalSources }),
  toggleTierFilter: (tier) => set((s) => ({ filters: { ...s.filters, tiers: toggled(s.filters.tiers, tier) } })),
  toggleStatusFilter: (status) => set((s) => ({ filters: { ...s.filters, statuses: toggled(s.filters.statuses, status) } })),
  toggleDomainFilter: (domain) => set((s) => ({ filters: { ...s.filters, domains: toggled(s.filters.domains, domain) } })),
  setSourceSearch: (search) => set((s) => ({ filters: { ...s.filters, search } })),
  clearSourceFilters: () => set({ filters: emptyFilters() }),
  setExpandedSource: (expandedSourceId) => set({ expandedSourceId }),
  setActiveView: (activeView) => set({ activeView }),
}));

/** The registry filtered by tier (override, then effective, then base: the tier a customer sees), status, domain, jurisdiction and a name, description and notes search. */
export function filterSources(sources: Source[], filters: SourceFilters): Source[] {
  const q = filters.search.toLowerCase();
  return sources.filter((s) => {
    const t = customerTierOf(s);
    if (filters.tiers.length > 0 && (t == null || !filters.tiers.includes(t as SourceTier))) return false;
    if (filters.statuses.length > 0 && !filters.statuses.includes(s.status)) return false;
    if (filters.domains.length > 0 && !filters.domains.some((d) => s.domains.includes(d as IntelligenceDomain))) return false;
    if (filters.jurisdictions.length > 0 && !filters.jurisdictions.some((j) => s.jurisdictions.includes(j))) return false;
    return !q || `${s.name} ${s.description} ${s.notes}`.toLowerCase().includes(q);
  });
}
